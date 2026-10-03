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
use std::sync::{Arc, Mutex, Weak};
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
    pub const REVOKED: u16 = 4414;
    pub const EVICTED: u16 = 4415;
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
    session_locks: Mutex<HashMap<(String, String), Weak<tokio::sync::Mutex<()>>>>,
    pub config: ResumeConfig,
}

pub struct Host {
    pub token: String,
    pub label: String,
    grant: String,
    resumable: bool,
    config: ResumeConfig,
    state: Mutex<State>,
    ended: watch::Receiver<Completion>,
    ended_tx: watch::Sender<Completion>,
    registry: Weak<Registry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Completion {
    Pending,
    Ended,
    Failed,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Cleanup {
    NotRequired,
    Pending,
    Succeeded,
    Failed,
}

struct State {
    out_log: VecDeque<(u64, String)>,
    out_bytes: usize,
    out_next: u64,
    in_last: u64,
    to_chain: Option<fmpsc::UnboundedSender<io::Result<String>>>,
    attachment: Option<(u64, mpsc::UnboundedSender<ToSocket>)>,
    generation: u64,
    ever_live: bool,
    transport_ended: bool,
    cleanup: Cleanup,
    finalized: bool,
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
            session_locks: Mutex::new(HashMap::new()),
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
        self.create_inner(grant, resumable, label, false)
    }

    /// Product hosts retain ownership until their resource owner reports the
    /// cleanup result. Fixtures without external resources use create instead.
    pub fn create_with_cleanup(
        self: &Arc<Self>,
        grant: &str,
        resumable: bool,
        label: String,
    ) -> (Arc<Host>, ChainIo) {
        self.create_inner(grant, resumable, label, true)
    }

    fn create_inner(
        self: &Arc<Self>,
        grant: &str,
        resumable: bool,
        label: String,
        cleanup_required: bool,
    ) -> (Arc<Host>, ChainIo) {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let (to_chain, chain_rx) = fmpsc::unbounded::<io::Result<String>>();
        let (chain_tx, mut from_chain) = fmpsc::unbounded::<String>();
        let (ended_tx, ended_rx) = watch::channel(Completion::Pending);
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
                ever_live: false,
                transport_ended: false,
                cleanup: if cleanup_required {
                    Cleanup::Pending
                } else {
                    Cleanup::NotRequired
                },
                finalized: false,
                acp_sessions: Vec::new(),
                end_reason: None,
            }),
            ended: ended_rx,
            ended_tx,
            registry: Arc::downgrade(self),
        });
        self.hosts
            .lock()
            .unwrap()
            .insert(token.clone(), host.clone());

        // Output pump. It ends when the chain drops its sink, which is when
        // the chain has finished; only then is the host finished, so the last
        // frames are logged before attachments are closed.
        let pump_host = host.clone();
        tokio::spawn(async move {
            while let Some(line) = from_chain.next().await {
                pump_host.on_chain_frame(line);
            }
            pump_host.finish();
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

    fn session_lock(&self, grant: &str, session: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.session_locks.lock().unwrap();
        // Keep only locks held by in-flight loads; completed session IDs must
        // not accumulate in this process-local serialization registry.
        locks.retain(|_, lock| lock.strong_count() > 0);
        let key = (grant.to_string(), session.to_string());
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    /// A load owns this guard through eviction, termination confirmation,
    /// claim and forwarding. No other loader can snapshot an owner-free gap.
    async fn claim_and_forward(
        &self,
        host: &Host,
        session: &str,
        message: String,
        wait: Duration,
    ) -> Result<(), u16> {
        let lock = self.session_lock(&host.grant, session);
        let _claim = lock.lock().await;
        if host.state.lock().unwrap().to_chain.is_none() {
            return Err(close::EVICTED);
        }
        if self
            .evict_session(&host.grant, session, &host.token, wait)
            .await
            .is_err()
        {
            host.kill("evicted");
            return Err(close::EVICTED);
        }
        let mut state = host.state.lock().unwrap();
        // This loader may have expired, been revoked or itself been evicted
        // while it waited. Never revive its chain or claim on its behalf.
        if state.to_chain.is_none() {
            return Err(close::EVICTED);
        }
        if !state.acp_sessions.iter().any(|id| id == session) {
            state.acp_sessions.push(session.to_string());
        }
        if state
            .to_chain
            .as_ref()
            .unwrap()
            .unbounded_send(Ok(message))
            .is_err()
        {
            Host::kill_locked(&mut state, "evicted");
            return Err(close::EVICTED);
        }
        Ok(())
    }

    /// Called only while holding the grant/session lock. One deadline covers
    /// every previous holder; a timeout or lost watcher never grants ownership.
    async fn evict_session(
        &self,
        grant: &str,
        session_id: &str,
        except: &str,
        wait: Duration,
    ) -> Result<(), u16> {
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
        for host in &holders {
            eprintln!(
                "[gateway] evicting host {} that still holds session {session_id}",
                host.label
            );
            host.kill("evicted");
        }
        let ended = holders.into_iter().map(|host| async move {
            let mut ended = host.ended.clone();
            match ended.wait_for(|ended| *ended != Completion::Pending).await {
                Ok(ended) if *ended == Completion::Ended => Ok(()),
                _ => Err(close::EVICTED),
            }
        });
        match tokio::time::timeout(wait, futures::future::join_all(ended)).await {
            Ok(results) if results.iter().all(Result::is_ok) => Ok(()),
            _ => {
                eprintln!(
                    "[gateway] session eviction could not confirm every previous host ended; refusing load"
                );
                Err(close::EVICTED)
            }
        }
    }

    pub async fn shutdown(&self) {
        let hosts: Vec<_> = self.hosts.lock().unwrap().values().cloned().collect();
        for host in &hosts {
            host.kill("gateway shutdown");
        }
        // One deadline for all hosts: a stalled chain cannot multiply shutdown time.
        let waits = hosts.into_iter().map(|host| async move {
            let mut ended = host.ended.clone();
            while *ended.borrow() == Completion::Pending {
                if ended.changed().await.is_err() {
                    break;
                }
            }
        });
        let _ =
            tokio::time::timeout(Duration::from_secs(10), futures::future::join_all(waits)).await;
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
        if !st.ever_live {
            Self::kill_locked(&mut st, "never attached");
            return;
        }
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
            self.forward(registry, text.to_string()).await?;
            self.state.lock().unwrap().ever_live = true;
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
                    self.forward(registry, message.to_string()).await?;
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
        self.state.lock().unwrap().ever_live = true;
        Ok(())
    }

    async fn forward(&self, registry: &Registry, message: String) -> Result<(), u16> {
        if (message.contains("\"session/load\"") || message.contains("\"session/resume\""))
            && let Ok(value) = serde_json::from_str::<Value>(&message)
        {
            let method = value.get("method").and_then(Value::as_str);
            let session = value.pointer("/params/sessionId").and_then(Value::as_str);
            if let (Some("session/load" | "session/resume"), Some(session)) = (method, session) {
                return registry
                    .claim_and_forward(self, session, message, Duration::from_secs(15))
                    .await;
            }
        }
        let st = self.state.lock().unwrap();
        if let Some(to_chain) = &st.to_chain {
            let _ = to_chain.unbounded_send(Ok(message));
        }
        Ok(())
    }

    pub fn kill(&self, reason: &'static str) {
        Self::kill_locked(&mut self.state.lock().unwrap(), reason);
    }

    fn kill_locked(st: &mut State, reason: &'static str) {
        st.end_reason.get_or_insert(reason);
        let terminal = match reason {
            "evicted" => Some(close::EVICTED),
            "grant revoked or expired" => Some(close::REVOKED),
            "frame too large" => Some(1009),
            _ => None,
        };
        if let Some(code) = terminal
            && let Some((_, socket)) = st.attachment.take()
        {
            let _ = socket.send(ToSocket::Close(code, reason));
        }
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

    /// Safe to use after an expired attach: recoverable expiry may be reported
    /// only after both transport termination and resource cleanup succeeded.
    pub async fn wait_for_completion(&self, deadline: Duration) -> bool {
        let mut ended = self.ended.clone();
        let result = tokio::time::timeout(
            deadline,
            ended.wait_for(|state| *state != Completion::Pending),
        )
        .await;
        matches!(result, Ok(Ok(state)) if *state == Completion::Ended)
    }

    /// Called by the product resource owner after boxed cleanup (or unboxed
    /// termination). Failed cleanup keeps this holder visible and fails loads.
    pub fn complete_cleanup(&self, success: bool) {
        let completion = {
            let mut st = self.state.lock().unwrap();
            if st.cleanup != Cleanup::Pending {
                return;
            }
            st.cleanup = if success {
                Cleanup::Succeeded
            } else {
                Cleanup::Failed
            };
            if !success {
                st.to_chain.take();
            }
            Self::finish_ready_locked(self, &mut st)
        };
        self.publish_completion(completion);
    }

    fn finish(&self) {
        let completion = {
            let mut st = self.state.lock().unwrap();
            st.to_chain.take();
            st.transport_ended = true;
            Self::finish_ready_locked(self, &mut st)
        };
        self.publish_completion(completion);
    }

    fn finish_ready_locked(&self, st: &mut State) -> Option<Completion> {
        if st.finalized
            || st.cleanup == Cleanup::Pending
            || (!st.transport_ended && st.cleanup != Cleanup::Failed)
        {
            return None;
        }
        st.finalized = true;
        let failed = st.cleanup == Cleanup::Failed;
        let reason = if failed {
            "owned resource cleanup failed"
        } else {
            *st.end_reason.get_or_insert("ended")
        };
        let code = if failed {
            close::EVICTED
        } else {
            match reason {
                "overflow" => close::OVERFLOW,
                "expired" => close::EXPIRED,
                "evicted" => close::EVICTED,
                "grant revoked or expired" => close::REVOKED,
                "frame too large" => 1009,
                _ => close::ENDED,
            }
        };
        // Recoverable final closes wait for successful cleanup, so a client
        // cannot race its replacement connection against the occupied slot.
        // kill_locked's explicit terminal close codes remain immediate.
        if let Some((_, tx)) = st.attachment.take() {
            let _ = tx.send(ToSocket::Close(code, reason));
        }
        eprintln!(
            "[gateway] host {} finished ({reason}); {} frames sent, {} retained",
            self.label,
            st.out_next - 1,
            st.out_log.len()
        );
        Some(if failed {
            Completion::Failed
        } else {
            Completion::Ended
        })
    }

    fn publish_completion(&self, completion: Option<Completion>) {
        if let Some(completion) = completion {
            if completion == Completion::Ended
                && let Some(registry) = self.registry.upgrade()
            {
                registry.hosts.lock().unwrap().remove(&self.token);
            }
            self.ended_tx.send_replace(completion);
        }
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

    #[tokio::test]
    async fn two_clients_loading_one_session_evict_with_terminal_code() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let (first, mut first_io) = registry.create("grant", true, "first".into());
        let (second, mut second_io) = registry.create("grant", true, "second".into());
        let (_, mut first_socket) = first.attach(0).unwrap_or_else(|_| panic!("attach first"));
        let (second_generation, _) = second.attach(0).unwrap_or_else(|_| panic!("attach second"));
        first
            .state
            .lock()
            .unwrap()
            .acp_sessions
            .push("shared-session".into());
        let first_chain = tokio::spawn(async move {
            assert!(first_io.incoming.next().await.is_none());
            drop(first_io.outgoing);
        });
        second.client_text(&registry, second_generation, r#"{"t":"m","s":1,"m":{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":"shared-session"}}}"#, &mut Vec::new()).await.unwrap();
        assert!(matches!(first_socket.recv().await, Some(ToSocket::Text(_))));
        assert!(matches!(
            first_socket.recv().await,
            Some(ToSocket::Close(close::EVICTED, "evicted"))
        ));
        assert!(second_io.incoming.next().await.unwrap().is_ok());
        assert!(second.state.lock().unwrap().end_reason.is_none());
        assert_eq!(registry.live_hosts(), 1);
        first_chain.await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_loads_serialize_eviction_claim_and_forwarding() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let (old, mut old_io) = registry.create("grant", true, "old".into());
        old.state
            .lock()
            .unwrap()
            .acp_sessions
            .push("shared-session".into());
        let (first, mut first_io) = registry.create("grant", true, "first".into());
        let (second, mut second_io) = registry.create("grant", true, "second".into());
        let (first_generation, _) = first.attach(0).unwrap_or_else(|_| panic!("first attach"));
        let (second_generation, _) = second.attach(0).unwrap_or_else(|_| panic!("second attach"));
        let first_load = first.clone();
        let second_load = second.clone();
        let loader_registry = registry.clone();
        let frame = r#"{"t":"m","s":1,"m":{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":"shared-session"}}}"#;
        let loads = tokio::spawn(async move {
            // Both futures are polled while old's output remains deliberately
            // alive. The first owns the lock; the second must queue behind it.
            let mut first_replies = Vec::new();
            let mut second_replies = Vec::new();
            tokio::join!(biased;
                first_load.client_text(&loader_registry, first_generation, frame, &mut first_replies),
                second_load.client_text(&loader_registry, second_generation, frame, &mut second_replies)
            )
        });
        assert!(
            tokio::time::timeout(Duration::from_secs(1), old_io.incoming.next())
                .await
                .unwrap()
                .is_none()
        );
        drop(old_io.outgoing);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), first_io.incoming.next())
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        // Second may evict first only after first claimed/forwarded. It must
        // then await first's controlled termination before its own forwarding.
        assert!(
            tokio::time::timeout(Duration::from_secs(1), first_io.incoming.next())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), second_io.incoming.next())
                .await
                .is_err()
        );
        assert!(second.state.lock().unwrap().acp_sessions.is_empty());
        drop(first_io.outgoing);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), second_io.incoming.next())
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        assert_eq!(loads.await.unwrap(), (Ok(()), Ok(())));
        assert_eq!(first.state.lock().unwrap().end_reason, Some("evicted"));
        assert_eq!(
            second.state.lock().unwrap().acp_sessions,
            vec!["shared-session"]
        );
        assert_eq!(registry.live_hosts(), 1);
    }

    #[tokio::test]
    async fn failed_old_host_termination_never_claims_or_forwards_a_load() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let (old, mut old_io) = registry.create("grant", true, "old".into());
        old.state
            .lock()
            .unwrap()
            .acp_sessions
            .push("shared-session".into());
        let (requester, mut requester_io) = registry.create("grant", true, "requester".into());
        let (_, mut socket) = requester.attach(0).unwrap_or_else(|_| panic!("attach"));
        let result = registry
            .claim_and_forward(
                &requester,
                "shared-session",
                "load-that-must-not-forward".into(),
                Duration::from_millis(10),
            )
            .await;
        assert_eq!(result, Err(close::EVICTED));
        assert!(old_io.incoming.next().await.is_none());
        assert!(requester_io.incoming.next().await.is_none());
        assert!(requester.state.lock().unwrap().acp_sessions.is_empty());
        assert!(matches!(socket.recv().await, Some(ToSocket::Text(_))));
        assert!(matches!(
            socket.recv().await,
            Some(ToSocket::Close(close::EVICTED, "evicted"))
        ));
        drop(old_io.outgoing);
    }

    #[tokio::test]
    async fn physical_cleanup_defers_next_load_and_keeps_explicit_eviction_immediate() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let (old, mut old_io) = registry.create_with_cleanup("grant", true, "old".into());
        old.state
            .lock()
            .unwrap()
            .acp_sessions
            .push("shared-session".into());
        let (_, mut old_socket) = old.attach(0).unwrap_or_else(|_| panic!("old attach"));
        assert!(matches!(old_socket.recv().await, Some(ToSocket::Text(_))));
        old.kill("expired");
        assert!(old_io.incoming.next().await.is_none());
        drop(old_io.outgoing);
        while !old.state.lock().unwrap().transport_ended {
            tokio::task::yield_now().await;
        }
        assert!(registry.find(&old.token, "grant").is_some());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), old_socket.recv())
                .await
                .is_err()
        );
        let (requester, mut requester_io) = registry.create("grant", true, "requester".into());
        let request = requester.clone();
        let claim_registry = registry.clone();
        let load = tokio::spawn(async move {
            claim_registry
                .claim_and_forward(
                    &request,
                    "shared-session",
                    "load".into(),
                    Duration::from_secs(1),
                )
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), requester_io.incoming.next())
                .await
                .is_err()
        );
        old.complete_cleanup(true);
        assert!(matches!(
            old_socket.recv().await,
            Some(ToSocket::Close(close::EVICTED, "evicted"))
        ));
        assert!(requester_io.incoming.next().await.unwrap().is_ok());
        assert_eq!(load.await.unwrap(), Ok(()));
        assert!(registry.find(&old.token, "grant").is_none());
    }

    #[tokio::test]
    async fn recoverable_close_waits_for_both_transport_and_successful_cleanup() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let (host, mut io) = registry.create_with_cleanup("grant", true, "expired".into());
        let (_, mut socket) = host.attach(0).unwrap_or_else(|_| panic!("attach"));
        assert!(matches!(socket.recv().await, Some(ToSocket::Text(_))));
        host.kill("expired");
        assert!(io.incoming.next().await.is_none());
        drop(io.outgoing);
        while !host.state.lock().unwrap().transport_ended {
            tokio::task::yield_now().await;
        }
        assert!(!host.wait_for_completion(Duration::from_millis(10)).await);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), socket.recv())
                .await
                .is_err()
        );
        host.complete_cleanup(true);
        assert!(host.wait_for_completion(Duration::from_millis(10)).await);
        assert!(matches!(
            socket.recv().await,
            Some(ToSocket::Close(close::EXPIRED, "expired"))
        ));
        assert!(registry.find(&host.token, "grant").is_none());

        let (host, io) = registry.create_with_cleanup("grant", true, "early-cleanup".into());
        host.complete_cleanup(true);
        assert!(!host.wait_for_completion(Duration::from_millis(10)).await);
        drop(io.outgoing);
        assert!(host.wait_for_completion(Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn failed_physical_cleanup_retains_holder_and_blocks_every_later_load() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let (old, old_io) = registry.create_with_cleanup("grant", true, "old".into());
        old.state
            .lock()
            .unwrap()
            .acp_sessions
            .push("shared-session".into());
        let (_, mut old_socket) = old.attach(0).unwrap_or_else(|_| panic!("old attach"));
        assert!(matches!(old_socket.recv().await, Some(ToSocket::Text(_))));
        drop(old_io.outgoing);
        while !old.state.lock().unwrap().transport_ended {
            tokio::task::yield_now().await;
        }
        old.complete_cleanup(false);
        assert!(!old.wait_for_completion(Duration::from_millis(100)).await);
        assert!(matches!(
            old_socket.recv().await,
            Some(ToSocket::Close(
                close::EVICTED,
                "owned resource cleanup failed"
            ))
        ));
        for label in ["first", "second"] {
            let (requester, mut requester_io) = registry.create("grant", true, label.into());
            let result = registry
                .claim_and_forward(
                    &requester,
                    "shared-session",
                    "load".into(),
                    Duration::from_millis(100),
                )
                .await;
            assert_eq!(result, Err(close::EVICTED));
            assert!(requester_io.incoming.next().await.is_none());
            assert!(requester.state.lock().unwrap().acp_sessions.is_empty());
            assert!(registry.find(&old.token, "grant").is_some());
        }
        // A contradictory later success cannot clear an unresolved failure.
        old.complete_cleanup(true);
        assert_eq!(*old.ended.borrow(), Completion::Failed);
        assert!(registry.find(&old.token, "grant").is_some());
    }

    #[tokio::test]
    async fn startup_client_that_never_became_live_gets_no_resume_grace() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let (host, mut io) = registry.create("grant", true, "startup".into());
        let (generation, _) = host.attach(0).unwrap_or_else(|_| panic!("attach"));
        host.detach(generation);
        assert_eq!(
            host.state.lock().unwrap().end_reason,
            Some("never attached")
        );
        assert!(io.incoming.next().await.is_none());
    }

    #[tokio::test]
    async fn shutdown_uses_one_concurrent_deadline() {
        let registry = Registry::new(ResumeConfig {
            grace: Duration::from_secs(600),
            max_retained_bytes: 4096,
        });
        let mut outputs = Vec::new();
        for i in 0..32 {
            let (_, io) = registry.create("grant", true, format!("host-{i}"));
            outputs.push(io.outgoing);
        }
        let started = std::time::Instant::now();
        registry.shutdown().await;
        assert!(started.elapsed() < Duration::from_secs(12));
        drop(outputs);
    }
}
