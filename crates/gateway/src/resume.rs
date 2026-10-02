//! Mobile-resilient sessions: a session host that outlives its WebSocket.
//!
//! Each host owns one ACP chain. A WebSocket is only an *attachment*. With the
//! opt-in `agent-connect.resume.v1` subprotocol, every ACP message travels in
//! an envelope with a per-direction sequence number:
//!
//! ```text
//! client -> gateway  {"t":"attach"} | {"t":"attach","resume":TOKEN,"ack":N}
//! gateway -> client  {"t":"attached","resume":TOKEN,"ack":M} | {"t":"expired"}
//! both directions    {"t":"m","s":SEQ,"m":<ACP JSON-RPC message>}
//! both directions    {"t":"a","s":SEQ}       highest sequence received
//! client -> gateway  {"t":"p","n":NONCE}     liveness probe
//! gateway -> client  {"t":"P","n":NONCE}
//! client -> gateway  {"t":"bye"}             deliberate end; no grace
//! ```
//!
//! Each side keeps what the other has not acknowledged and resends it after a
//! reattach; receivers drop duplicates by sequence. A detached host keeps
//! running for a grace period with bounded retained output, then is torn down
//! through the normal path: the chain's input ends.
//!
//! This is an Agent Connect transport extension below ACP, not an ACP
//! standard. ACP v1 defers stream resumption to v2.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::channel::mpsc as fmpsc;
use futures::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

pub const RESUME_SUBPROTOCOL: &str = "agent-connect.resume.v1";

/// WebSocket close codes the gateway uses for attachments.
pub mod close {
    pub const BAD_FRAME: u16 = 4400;
    pub const EXPIRED: u16 = 4404;
    pub const SUPERSEDED: u16 = 4409;
    pub const ENDED: u16 = 4410;
    pub const OVERFLOW: u16 = 4413;
}

#[derive(Clone, Copy, Debug)]
pub struct ResumeConfig {
    pub grace: Duration,
    pub max_retained_bytes: usize,
}

/// What an attachment's socket task is asked to send.
#[derive(Debug)]
pub enum ToSocket {
    Text(String),
    Close(u16, &'static str),
}

/// The chain side of a host, handed to `Lines::new`.
pub struct ChainIo {
    pub outgoing: Pin<Box<dyn Sink<String, Error = io::Error> + Send>>,
    pub incoming: Pin<Box<dyn Stream<Item = io::Result<String>> + Send>>,
}

pub struct Registry {
    hosts: Mutex<HashMap<String, Arc<Host>>>,
    pub config: ResumeConfig,
}

pub struct Host {
    pub token: String,
    pub label: String,
    grant: String,
    resumable: bool,
    config: ResumeConfig,
    state: Mutex<State>,
    ended: watch::Receiver<bool>,
}

struct State {
    out_log: VecDeque<(u64, String)>,
    out_bytes: usize,
    out_next: u64,
    in_last: u64,
    to_chain: Option<fmpsc::UnboundedSender<io::Result<String>>>,
    attachment: Option<(u64, mpsc::UnboundedSender<ToSocket>)>,
    generation: u64,
    acp_sessions: Vec<String>,
    end_reason: Option<&'static str>,
}

pub enum AttachError {
    Expired,
}

impl Registry {
    pub fn new(config: ResumeConfig) -> Arc<Self> {
        Arc::new(Self {
            hosts: Mutex::new(HashMap::new()),
            config,
        })
    }

    /// Creates a host and the I/O its chain must run on. The host removes
    /// itself from the registry once the chain has ended.
    pub fn create(
        self: &Arc<Self>,
        grant: &str,
        resumable: bool,
        label: String,
    ) -> (Arc<Host>, ChainIo) {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let (to_chain, chain_rx) = fmpsc::unbounded::<io::Result<String>>();
        let (chain_tx, mut from_chain) = fmpsc::unbounded::<String>();
        let (ended_tx, ended_rx) = watch::channel(false);
        let host = Arc::new(Host {
            token: token.clone(),
            label,
            grant: grant.to_string(),
            resumable,
            config: self.config,
            state: Mutex::new(State {
                out_log: VecDeque::new(),
                out_bytes: 0,
                out_next: 1,
                in_last: 0,
                to_chain: Some(to_chain),
                attachment: None,
                generation: 0,
                acp_sessions: Vec::new(),
                end_reason: None,
            }),
            ended: ended_rx,
        });
        self.hosts
            .lock()
            .unwrap()
            .insert(token.clone(), host.clone());

        // Output pump. It ends when the chain drops its sink, which is when
        // the chain has finished; only then is the host finished, so the last
        // frames are logged before attachments are closed.
        let pump_host = host.clone();
        let registry = self.clone();
        tokio::spawn(async move {
            while let Some(line) = from_chain.next().await {
                pump_host.on_chain_frame(line);
            }
            pump_host.finish();
            registry.hosts.lock().unwrap().remove(&pump_host.token);
            let _ = ended_tx.send(true);
        });

        let io = ChainIo {
            outgoing: Box::pin(chain_tx.sink_map_err(io::Error::other)),
            incoming: Box::pin(chain_rx),
        };
        (host, io)
    }

    pub fn find(&self, token: &str, grant: &str) -> Option<Arc<Host>> {
        let host = self.hosts.lock().unwrap().get(token).cloned()?;
        constant_time_eq(host.grant.as_bytes(), grant.as_bytes()).then_some(host)
    }

    /// Ends every other live host of this grant that holds `session_id`, and
    /// waits until each has finished, so two adapter processes never drive
    /// one session. Used before admitting `session/load` from a fresh client.
    pub async fn evict_session(&self, grant: &str, session_id: &str, except: &str) {
        let holders: Vec<Arc<Host>> = self
            .hosts
            .lock()
            .unwrap()
            .values()
            .filter(|h| h.token != except && h.grant == grant)
            .filter(|h| {
                h.state
                    .lock()
                    .unwrap()
                    .acp_sessions
                    .iter()
                    .any(|s| s == session_id)
            })
            .cloned()
            .collect();
        for host in holders {
            eprintln!(
                "[gateway] evicting host {} that still holds session {session_id}",
                host.label
            );
            host.kill("evicted");
            let mut ended = host.ended.clone();
            let _ = tokio::time::timeout(Duration::from_secs(15), ended.wait_for(|e| *e)).await;
        }
    }

    pub fn live_hosts(&self) -> usize {
        self.hosts.lock().unwrap().len()
    }
}

impl Host {
    pub fn is_resumable(&self) -> bool {
        self.resumable
    }

    fn on_chain_frame(&self, line: String) {
        let line = line.trim_end().to_string();
        let mut st = self.state.lock().unwrap();
        if line.contains("\"sessionId\"")
            && line.contains("\"result\"")
            && let Ok(value) = serde_json::from_str::<Value>(&line)
            && let Some(id) = value.pointer("/result/sessionId").and_then(Value::as_str)
            && !st.acp_sessions.iter().any(|s| s == id)
        {
            st.acp_sessions.push(id.to_string());
        }
        if !self.resumable {
            if let Some((_, tx)) = &st.attachment {
                let _ = tx.send(ToSocket::Text(line));
            }
            return;
        }
        let seq = st.out_next;
        st.out_next += 1;
        let frame = format!(r#"{{"t":"m","s":{seq},"m":{line}}}"#);
        st.out_bytes += frame.len();
        if let Some((_, tx)) = &st.attachment {
            let _ = tx.send(ToSocket::Text(frame.clone()));
        }
        st.out_log.push_back((seq, frame));
        // The bound is for a detached host. An attached client acknowledges
        // within moments, so it only gets a generous hard cap; a dead
        // attachment is detached by the ping check first.
        let bound = if st.attachment.is_some() {
            self.config
                .max_retained_bytes
                .saturating_mul(8)
                .max(1024 * 1024)
        } else {
            self.config.max_retained_bytes
        };
        if st.out_bytes > bound && st.to_chain.is_some() {
            eprintln!(
                "[gateway] host {} retained {} unacknowledged bytes; ending it",
                self.label, st.out_bytes
            );
            Self::kill_locked(&mut st, "overflow");
        }
    }

    /// Attaches a socket. Returns the attachment generation and the queue the
    /// socket task must drain. For resumable hosts, the queue starts with the
    /// `attached` frame and every retained frame after `ack`.
    pub fn attach(
        &self,
        ack: u64,
    ) -> Result<(u64, mpsc::UnboundedReceiver<ToSocket>), AttachError> {
        let mut st = self.state.lock().unwrap();
        if st.to_chain.is_none() {
            return Err(AttachError::Expired);
        }
        if let Some((_, old)) = st.attachment.take() {
            let _ = old.send(ToSocket::Close(close::SUPERSEDED, "superseded"));
        }
        st.generation += 1;
        let generation = st.generation;
        let (tx, rx) = mpsc::unbounded_channel();
        if self.resumable {
            Self::prune_locked(&mut st, ack);
            let attached = json!({"t": "attached", "resume": self.token, "ack": st.in_last});
            let _ = tx.send(ToSocket::Text(attached.to_string()));
            let mut replayed = 0;
            for (_, frame) in &st.out_log {
                let _ = tx.send(ToSocket::Text(frame.clone()));
                replayed += 1;
            }
            if generation > 1 {
                eprintln!(
                    "[gateway] host {} reattached (generation {generation}); client ack {ack}, replaying {replayed} frames, gateway ack {}",
                    self.label, st.in_last
                );
            }
        }
        st.attachment = Some((generation, tx));
        Ok((generation, rx))
    }

    /// The attachment's socket ended. A plain host ends now; a resumable host
    /// gets its grace period.
    pub fn detach(self: &Arc<Self>, generation: u64) {
        let mut st = self.state.lock().unwrap();
        if st.attachment.as_ref().map(|(g, _)| *g) != Some(generation) {
            return;
        }
        st.attachment = None;
        if !self.resumable {
            Self::kill_locked(&mut st, "closed");
            return;
        }
        if st.to_chain.is_none() {
            return;
        }
        eprintln!(
            "[gateway] host {} detached; grace {:?}",
            self.label, self.config.grace
        );
        let host = self.clone();
        let grace = self.config.grace;
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let mut st = host.state.lock().unwrap();
            if st.attachment.is_none() && st.generation == generation {
                eprintln!("[gateway] host {} grace expired; ending it", host.label);
                Self::kill_locked(&mut st, "expired");
            }
        });
    }

    /// Handles one text frame from the attached client. Replies for the
    /// socket go to `replies`; ACP messages go to the chain. Returns a close
    /// code on a protocol error.
    pub async fn client_text(
        &self,
        registry: &Registry,
        generation: u64,
        text: &str,
        replies: &mut Vec<String>,
    ) -> Result<(), u16> {
        if self.state.lock().unwrap().generation != generation {
            return Err(close::SUPERSEDED);
        }
        if !self.resumable {
            self.forward(registry, text.to_string()).await;
            return Ok(());
        }
        let envelope: Value = serde_json::from_str(text).map_err(|_| close::BAD_FRAME)?;
        match envelope.get("t").and_then(Value::as_str) {
            Some("m") => {
                let seq = envelope
                    .get("s")
                    .and_then(Value::as_u64)
                    .ok_or(close::BAD_FRAME)?;
                let message = envelope.get("m").ok_or(close::BAD_FRAME)?;
                let accept = {
                    let mut st = self.state.lock().unwrap();
                    if seq == st.in_last + 1 {
                        st.in_last = seq;
                        true
                    } else {
                        if seq > st.in_last + 1 {
                            eprintln!(
                                "[gateway] host {} client frame {seq} after {}: gap, dropped",
                                self.label, st.in_last
                            );
                        }
                        false
                    }
                };
                if accept {
                    self.forward(registry, message.to_string()).await;
                }
                let in_last = self.state.lock().unwrap().in_last;
                replies.push(json!({"t": "a", "s": in_last}).to_string());
            }
            Some("a") => {
                let seq = envelope
                    .get("s")
                    .and_then(Value::as_u64)
                    .ok_or(close::BAD_FRAME)?;
                Self::prune_locked(&mut self.state.lock().unwrap(), seq);
            }
            Some("bye") => self.kill("closed by client"),
            Some("p") => {
                let in_last = self.state.lock().unwrap().in_last;
                replies.push(
                    json!({"t": "P", "n": envelope.get("n").cloned().unwrap_or(Value::Null), "ack": in_last})
                        .to_string(),
                );
            }
            _ => return Err(close::BAD_FRAME),
        }
        Ok(())
    }

    async fn forward(&self, registry: &Registry, message: String) {
        if (message.contains("\"session/load\"") || message.contains("\"session/resume\""))
            && let Ok(value) = serde_json::from_str::<Value>(&message)
        {
            let method = value.get("method").and_then(Value::as_str);
            let session = value.pointer("/params/sessionId").and_then(Value::as_str);
            if let (Some("session/load" | "session/resume"), Some(session)) = (method, session) {
                registry
                    .evict_session(&self.grant, session, &self.token)
                    .await;
                let mut st = self.state.lock().unwrap();
                if !st.acp_sessions.iter().any(|s| s == session) {
                    st.acp_sessions.push(session.to_string());
                }
            }
        }
        let st = self.state.lock().unwrap();
        if let Some(to_chain) = &st.to_chain {
            let _ = to_chain.unbounded_send(Ok(message));
        }
    }

    pub fn kill(&self, reason: &'static str) {
        Self::kill_locked(&mut self.state.lock().unwrap(), reason);
    }

    fn kill_locked(st: &mut State, reason: &'static str) {
        st.end_reason.get_or_insert(reason);
        // Dropping the chain's input ends the chain, the same path a closed
        // socket took before hosts existed.
        st.to_chain.take();
    }

    fn prune_locked(st: &mut State, ack: u64) {
        while st.out_log.front().is_some_and(|(seq, _)| *seq <= ack) {
            let (_, frame) = st.out_log.pop_front().unwrap();
            st.out_bytes -= frame.len();
        }
    }

    fn finish(&self) {
        let mut st = self.state.lock().unwrap();
        st.to_chain.take();
        let reason = *st.end_reason.get_or_insert("ended");
        let code = match reason {
            "overflow" => close::OVERFLOW,
            "expired" => close::EXPIRED,
            _ => close::ENDED,
        };
        if let Some((_, tx)) = st.attachment.take() {
            let _ = tx.send(ToSocket::Close(code, reason));
        }
        eprintln!(
            "[gateway] host {} finished ({reason}); {} frames sent, {} retained",
            self.label,
            st.out_next - 1,
            st.out_log.len()
        );
    }
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reattach_keeps_sequence_and_drops_duplicate_client_frames() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(60),
            max_retained_bytes: 4096,
        });
        let (host, mut io) = registry.create("grant", true, "test".into());
        let (first, _) = host.attach(0).unwrap_or_else(|_| panic!("first attach"));
        let mut replies = Vec::new();
        let frame =
            r#"{"t":"m","s":1,"m":{"jsonrpc":"2.0","method":"session/cancel","params":{}}}"#;
        host.client_text(&registry, first, frame, &mut replies)
            .await
            .unwrap();
        host.client_text(&registry, first, frame, &mut replies)
            .await
            .unwrap();
        assert!(io.incoming.next().await.unwrap().is_ok());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), io.incoming.next())
                .await
                .is_err()
        );
        host.on_chain_frame(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into());
        host.detach(first);
        let (second, mut replay) = host.attach(0).unwrap_or_else(|_| panic!("reattach"));
        assert!(matches!(replay.recv().await, Some(ToSocket::Text(s)) if s.contains("attached")));
        assert!(matches!(replay.recv().await, Some(ToSocket::Text(s)) if s.contains("\"s\":1")));
        assert_eq!(
            host.client_text(&registry, first, frame, &mut replies)
                .await,
            Err(close::SUPERSEDED)
        );
        host.client_text(&registry, second, r#"{"t":"a","s":1}"#, &mut replies)
            .await
            .unwrap();
        assert!(host.state.lock().unwrap().out_log.is_empty());
        assert!(registry.find(&host.token, "wrong-grant").is_none());
    }

    #[tokio::test]
    async fn detached_retention_is_bounded() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(60),
            max_retained_bytes: 16,
        });
        let (host, _io) = registry.create("grant", true, "test".into());
        host.on_chain_frame("{}".into());
        assert_eq!(host.state.lock().unwrap().end_reason, Some("overflow"));
        assert!(host.attach(0).is_err());
    }
}
