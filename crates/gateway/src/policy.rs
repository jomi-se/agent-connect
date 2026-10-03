//! Agent Connect policy proxy: the only component that sees untrusted
//! application traffic. It is default-deny in both directions and uses only
//! generic ACP and MCP-over-ACP message shapes, never harness-specific events.
//!
//! Chain position: app -> [PolicyProxy] -> McpOverAcpPolyfill -> adapter.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::METHOD_INITIALIZE_PROXY;
use agent_client_protocol::util::MatchDispatchFrom;
use agent_client_protocol::{
    Agent, Client, Conductor, ConnectTo, ConnectionTo, Dispatch, HandleDispatchFrom, Handled,
    Proxy, Responder, UntypedMessage,
};
use serde_json::{Value, json};

/// How the gateway answers harness permission prompts. Prompts are never shown
/// to the application: the application is not the approver for host authority.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionProfile {
    /// Allow everything the harness asks for. Only safe when the harness runs
    /// inside a disposable sandbox with nothing valuable in it.
    Sandboxed,
    /// Deny every prompt.
    DenyAll,
    /// Allow only prompts attributable to a granted application tool; deny
    /// every harness-native action. Attribution uses the adapters' tool-call
    /// titles (`mcp.app.*` for codex-acp, `mcp__app__*` for claude-agent-acp),
    /// which is harness-specific: acceptable for a host-run smoke test, not as
    /// a production boundary.
    AppToolsOnly,
}

#[derive(Debug)]
pub struct PolicyConfig {
    /// Scratch directory that replaces any application-supplied `cwd`.
    pub workspace: PathBuf,
    /// Name of the single MCP-over-ACP server an application may declare.
    pub app_server_name: String,
    /// Consented tool snapshot: tool name -> exact input schema. `None` runs
    /// in record mode, which admits and prints whatever the app lists.
    pub snapshot: Option<BTreeMap<String, Value>>,
    /// Approved public tool definitions; no unapproved descriptions or annotations.
    pub tool_definitions: Option<BTreeMap<String, Value>>,
    pub permissions: PermissionProfile,
    /// Recent sessions created under this grant (session id -> workspace), shared by
    /// every connection that presents the same grant. `session/load` and
    /// `session/resume` are admitted only for these ids, pinned to their
    /// original workspace because harnesses key stored sessions by `cwd`.
    /// Ownership expires after 24 hours of inactivity; at most 256 sessions remain.
    pub grant_sessions: GrantSessions,
    /// Gateway-owned journal, written before an application action is delivered.
    pub actions_dir: Option<PathBuf>,
}

pub type GrantSessions = Arc<Mutex<RecentSessions>>;

const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_SESSIONS: usize = 256;
const MAX_TOOL_TITLES: usize = 256;

/// Process-local ownership only: eviction never resumes or replays a session.
#[derive(Debug, Default)]
pub struct RecentSessions {
    entries: BTreeMap<String, (PathBuf, Instant)>,
}
impl RecentSessions {
    fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|_, (_, seen)| now.saturating_duration_since(*seen) < SESSION_TTL);
    }
    fn insert(&mut self, id: String, workspace: PathBuf) {
        let now = Instant::now();
        self.prune(now);
        if !self.entries.contains_key(&id) && self.entries.len() >= MAX_SESSIONS {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, seen))| *seen)
                .map(|(id, _)| id.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(id, (workspace, now));
    }
    fn get(&mut self, id: &str) -> Option<PathBuf> {
        let now = Instant::now();
        self.prune(now);
        let (workspace, seen) = self.entries.get_mut(id)?;
        *seen = now;
        Some(workspace.clone())
    }
}

#[derive(Default, Debug)]
struct PolicyState {
    /// `serverId`s the application declared in admitted session setup.
    declared_servers: HashSet<String>,
    session_id: Option<String>,
    prompting: bool,
    /// toolCallId -> latest title seen in `session/update`, for attributing
    /// permission prompts whose own title is empty (codex-acp MCP prompts).
    tool_titles: BTreeMap<String, String>,
}

pub struct PolicyProxy {
    config: Arc<PolicyConfig>,
}

impl PolicyProxy {
    pub fn new(config: PolicyConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }
}

impl ConnectTo<Conductor> for PolicyProxy {
    async fn connect_to(
        self,
        client: impl ConnectTo<Proxy>,
    ) -> Result<(), agent_client_protocol::Error> {
        let handler = PolicyHandler {
            config: self.config,
            state: Arc::new(Mutex::new(PolicyState::default())),
        };
        Proxy
            .builder()
            .name("agent-connect-policy")
            .with_handler(handler)
            .connect_to(client)
            .await
    }
}

struct PolicyHandler {
    config: Arc<PolicyConfig>,
    state: Arc<Mutex<PolicyState>>,
}

impl HandleDispatchFrom<Conductor> for PolicyHandler {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        cx: ConnectionTo<Conductor>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        MatchDispatchFrom::new(message, &cx)
            .if_dispatch_from(Client, async |m: Dispatch| self.handle_app(m, &cx))
            .await
            .if_dispatch_from(Agent, async |m: Dispatch| self.handle_agent(m, &cx).await)
            .await
            .done()
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "agent-connect-policy"
    }
}

type Outcome = Result<Handled<Dispatch>, agent_client_protocol::Error>;

fn pass(message: Dispatch) -> Outcome {
    Ok(Handled::No {
        message,
        retry: false,
    })
}

fn deny(responder: Responder, error: agent_client_protocol::Error, why: &str) -> Outcome {
    eprintln!("[policy] deny: {why}");
    responder.respond_with_error(error)?;
    Ok(Handled::Yes)
}

/// Inner MCP methods a harness may send to the application's server.
const MCP_REQUESTS_TO_APP: &[&str] = &["initialize", "ping", "tools/list", "tools/call"];
const MCP_NOTIFICATIONS_TO_APP: &[&str] = &["notifications/initialized", "notifications/cancelled"];
/// Inner MCP notifications the application's server may send to the harness.
const MCP_NOTIFICATIONS_FROM_APP: &[&str] = &["notifications/cancelled", "notifications/progress"];

impl PolicyHandler {
    // ------------------------------------------------ application -> agent ---

    fn handle_app(&self, message: Dispatch, cx: &ConnectionTo<Conductor>) -> Outcome {
        match message {
            Dispatch::Request(mut request, responder) => match request.method() {
                METHOD_INITIALIZE_PROXY => {
                    request.method = "initialize".into();
                    restrict_client_capabilities(&mut request.params);
                    cx.send_request_to(Agent, request)
                        .forward_cancellation_from(responder.cancellation())
                        .forward_response_to(responder)?;
                    Ok(Handled::Yes)
                }
                "session/new" => {
                    self.admit_session_setup(
                        &mut request.params,
                        "session/new",
                        &self.config.workspace.clone(),
                    );
                    let sessions = self.config.grant_sessions.clone();
                    let state = self.state.clone();
                    let workspace = self.config.workspace.clone();
                    cx.send_request_to(Agent, request)
                        .forward_cancellation_from(responder.cancellation())
                        .on_receiving_result(async move |result| {
                            if let Some(id) = result
                                .as_ref()
                                .ok()
                                .and_then(|r| r.get("sessionId"))
                                .and_then(Value::as_str)
                            {
                                sessions.lock().unwrap().insert(id.to_string(), workspace);
                                state.lock().unwrap().session_id = Some(id.to_string());
                            }
                            responder.respond_with_result(result)
                        })?;
                    Ok(Handled::Yes)
                }
                "session/load" | "session/resume" => {
                    let method = request.method.clone();
                    let id = request
                        .params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let Some(workspace) = self.config.grant_sessions.lock().unwrap().get(&id)
                    else {
                        return deny(
                            responder,
                            agent_client_protocol::Error::invalid_params()
                                .data(json!({"sessionId": id})),
                            &format!("{method} of a session this grant does not own"),
                        );
                    };
                    self.state.lock().unwrap().session_id = Some(id.clone());
                    self.admit_session_setup(&mut request.params, &method, &workspace);
                    cx.send_request_to(Agent, request)
                        .forward_cancellation_from(responder.cancellation())
                        .forward_response_to(responder)?;
                    Ok(Handled::Yes)
                }
                "session/prompt" => {
                    let mut state = self.state.lock().unwrap();
                    let id = request.params.get("sessionId").and_then(Value::as_str);
                    if id.is_none() || id != state.session_id.as_deref() || state.prompting {
                        return deny(
                            responder,
                            agent_client_protocol::Error::invalid_params(),
                            "unknown session or active prompt",
                        );
                    }
                    if self
                        .config
                        .grant_sessions
                        .lock()
                        .unwrap()
                        .get(id.unwrap())
                        .is_none()
                    {
                        return deny(
                            responder,
                            agent_client_protocol::Error::invalid_params(),
                            "expired session ownership",
                        );
                    }
                    state.prompting = true;
                    drop(state);
                    let state = self.state.clone();
                    cx.send_request_to(Agent, request)
                        .forward_cancellation_from(responder.cancellation())
                        .on_receiving_result(async move |result| {
                            let mut state = state.lock().unwrap();
                            state.prompting = false;
                            state.tool_titles.clear();
                            drop(state);
                            responder.respond_with_result(result)
                        })?;
                    Ok(Handled::Yes)
                }
                method => {
                    let why = format!("application request {method}");
                    deny(
                        responder,
                        agent_client_protocol::Error::method_not_found().data(json!(method)),
                        &why,
                    )
                }
            },
            Dispatch::Notification(notification) => match notification.method() {
                "session/cancel" => {
                    let state = self.state.lock().unwrap();
                    let id = notification.params.get("sessionId").and_then(Value::as_str);
                    if id.is_some() && id == state.session_id.as_deref() {
                        pass(Dispatch::Notification(notification))
                    } else {
                        Ok(Handled::Yes)
                    }
                }
                "$/cancel_request" => pass(Dispatch::Notification(notification)),
                "mcp/message"
                    if inner_method_in(&notification.params, MCP_NOTIFICATIONS_FROM_APP) =>
                {
                    pass(Dispatch::Notification(notification))
                }
                method => {
                    eprintln!(
                        "[policy] drop application notification {method} {}",
                        inner_method(&notification.params).unwrap_or("")
                    );
                    Ok(Handled::Yes)
                }
            },
            response @ Dispatch::Response(..) => pass(response),
        }
    }

    fn admit_session_setup(&self, params: &mut Value, method: &str, workspace: &PathBuf) {
        let Some(obj) = params.as_object_mut() else {
            return;
        };
        obj.retain(|key, _| key == "sessionId" || key == "mcpServers");
        obj.insert("cwd".into(), json!(workspace));
        let requested = obj
            .remove("mcpServers")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        self.state.lock().unwrap().declared_servers.clear();
        let mut admitted = Vec::new();
        for server in requested {
            let is_app = server.get("type").and_then(Value::as_str) == Some("acp")
                && server.get("name").and_then(Value::as_str)
                    == Some(self.config.app_server_name.as_str());
            if is_app && admitted.is_empty() {
                if let Some(id) = server.get("serverId").and_then(Value::as_str) {
                    self.state
                        .lock()
                        .unwrap()
                        .declared_servers
                        .insert(id.to_string());
                }
                admitted.push(server);
            } else {
                eprintln!("[policy] {method}: dropped MCP server declaration {server}");
            }
        }
        obj.insert("mcpServers".into(), Value::Array(admitted));
    }

    // ------------------------------------------------ agent -> application ---

    async fn handle_agent(&self, message: Dispatch, cx: &ConnectionTo<Conductor>) -> Outcome {
        match message {
            Dispatch::Request(request, responder) => match request.method() {
                "mcp/connect" => {
                    let id = request
                        .params
                        .get("serverId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if self.state.lock().unwrap().declared_servers.contains(id) {
                        pass(Dispatch::Request(request, responder))
                    } else {
                        deny(
                            responder,
                            agent_client_protocol::Error::invalid_params(),
                            &format!("mcp/connect to undeclared server {id}"),
                        )
                    }
                }
                "mcp/disconnect" => pass(Dispatch::Request(request, responder)),
                "mcp/message" => self.mcp_request_to_app(request, responder, cx).await,
                "session/request_permission" => self.answer_permission(&request.params, responder),
                method => {
                    let why = format!("agent request {method}");
                    deny(
                        responder,
                        agent_client_protocol::Error::method_not_found().data(json!(method)),
                        &why,
                    )
                }
            },
            Dispatch::Notification(notification) => match notification.method() {
                "session/update" => {
                    let update = &notification.params["update"];
                    if let Some(id) = update.get("toolCallId").and_then(Value::as_str) {
                        let mut state = self.state.lock().unwrap();
                        if matches!(
                            update.get("status").and_then(Value::as_str),
                            Some("completed" | "failed")
                        ) {
                            state.tool_titles.remove(id);
                        } else if let Some(title) = update
                            .get("title")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                        {
                            if state.tool_titles.len() >= MAX_TOOL_TITLES
                                && !state.tool_titles.contains_key(id)
                            {
                                // Only an attribution hint. Dropping hints fails closed for AppToolsOnly.
                                state.tool_titles.clear();
                            }
                            state.tool_titles.insert(id.to_string(), title.to_string());
                        }
                    }
                    pass(Dispatch::Notification(notification))
                }
                "$/cancel_request" => pass(Dispatch::Notification(notification)),
                "mcp/message"
                    if inner_method_in(&notification.params, MCP_NOTIFICATIONS_TO_APP) =>
                {
                    pass(Dispatch::Notification(notification))
                }
                method => {
                    eprintln!(
                        "[policy] drop agent notification {method} {}",
                        inner_method(&notification.params).unwrap_or("")
                    );
                    Ok(Handled::Yes)
                }
            },
            response @ Dispatch::Response(..) => pass(response),
        }
    }

    async fn mcp_request_to_app(
        &self,
        mut request: UntypedMessage,
        responder: Responder,
        cx: &ConnectionTo<Conductor>,
    ) -> Outcome {
        let method = inner_method(&request.params).unwrap_or("").to_string();
        if !MCP_REQUESTS_TO_APP.contains(&method.as_str()) {
            // Includes MCP 2026-07-28 `server/discover`: refusing it with
            // method-not-found lets modern clients fall back to `initialize`.
            return deny(
                responder,
                agent_client_protocol::Error::method_not_found().data(json!(method)),
                &format!("MCP {method} to app"),
            );
        }
        match method.as_str() {
            "tools/call" => {
                let name = request
                    .params
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let admitted = self
                    .config
                    .snapshot
                    .as_ref()
                    .is_none_or(|s| s.contains_key(&name));
                if admitted {
                    eprintln!("[policy] tools/call {name}");
                    let action_id = uuid::Uuid::new_v4().to_string();
                    let Some(object) = request.params.as_object_mut() else {
                        return deny(
                            responder,
                            agent_client_protocol::Error::invalid_params(),
                            "invalid MCP request",
                        );
                    };
                    let metadata = object.entry("_meta").or_insert_with(|| json!({}));
                    let Some(metadata) = metadata.as_object_mut() else {
                        return deny(
                            responder,
                            agent_client_protocol::Error::invalid_params(),
                            "invalid MCP metadata",
                        );
                    };
                    metadata.insert("agent-connect/actionId".into(), json!(action_id));
                    if let Some(dir) = &self.config.actions_dir {
                        let dir = dir.clone();
                        let pending_id = action_id.clone();
                        let persisted =
                            tokio::task::spawn_blocking(move || persist_action(&dir, &pending_id))
                                .await;
                        if !matches!(persisted, Ok(Ok(()))) {
                            return deny(
                                responder,
                                agent_client_protocol::Error::internal_error(),
                                "action journal unavailable or unresolved capacity exhausted",
                            );
                        }
                    }
                    let actions_dir = self.config.actions_dir.clone();
                    cx.send_request_to(Client, request)
                        .forward_cancellation_from(responder.cancellation())
                        .on_receiving_result(async move |result| {
                            if let Some(dir) = actions_dir {
                                let status = match &result {
                                    Ok(value) if value.get("isError").and_then(Value::as_bool) == Some(true) => ActionStatus::Failed,
                                    Ok(_) => ActionStatus::Completed,
                                    Err(_) => ActionStatus::Uncertain,
                                };
                                let recorded = tokio::task::spawn_blocking(move || finish_action(&dir, &action_id, status)).await;
                                if !matches!(recorded, Ok(Ok(()))) {
                                    // The application may already have changed state. Preserve
                                    // its known outcome instead of fabricating a retryable error.
                                    // Initial pending evidence remains if completion could not persist.
                                    eprintln!("[policy] action lifecycle write failed; durable action evidence remains");
                                }
                            }
                            responder.respond_with_result(result)
                        })?;
                    Ok(Handled::Yes)
                } else {
                    deny(
                        responder,
                        agent_client_protocol::Error::invalid_params().data(json!({"tool": name})),
                        &format!("unapproved tool {name}"),
                    )
                }
            }
            "tools/list" => {
                let config = self.config.clone();
                cx.send_request_to(Client, request)
                    .forward_cancellation_from(responder.cancellation())
                    .on_receiving_result(async move |result| {
                        responder.respond_with_result(
                            result.map(|listed| filter_tool_list(listed, &config)),
                        )
                    })?;
                Ok(Handled::Yes)
            }
            _ => pass(Dispatch::Request(request, responder)),
        }
    }

    fn answer_permission(&self, params: &Value, responder: Responder) -> Outcome {
        const ALLOW: [&str; 2] = ["allow_once", "allow_always"];
        const REJECT: [&str; 2] = ["reject_once", "reject_always"];
        let own_title = params
            .pointer("/toolCall/title")
            .and_then(Value::as_str)
            .unwrap_or("");
        let seen_title = params
            .pointer("/toolCall/toolCallId")
            .and_then(Value::as_str)
            .and_then(|id| self.state.lock().unwrap().tool_titles.get(id).cloned())
            .unwrap_or_default();
        let app = &self.config.app_server_name;
        let is_app_tool = [own_title, seen_title.as_str()].iter().any(|t| {
            t.starts_with(&format!("mcp.{app}.")) || t.starts_with(&format!("mcp__{app}__"))
        });
        let wanted = match self.config.permissions {
            PermissionProfile::Sandboxed => ALLOW,
            PermissionProfile::DenyAll => REJECT,
            PermissionProfile::AppToolsOnly if is_app_tool => ALLOW,
            PermissionProfile::AppToolsOnly => REJECT,
        };
        eprintln!(
            "[policy] permission prompt title={own_title:?} seen={seen_title:?} app_tool={is_app_tool}"
        );
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let chosen = wanted.iter().find_map(|kind| {
            options
                .iter()
                .find(|o| o.get("kind").and_then(Value::as_str) == Some(*kind))
        });
        let title = params
            .pointer("/toolCall/title")
            .and_then(Value::as_str)
            .unwrap_or("");
        let outcome = match chosen.and_then(|o| o.get("optionId")) {
            Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        };
        eprintln!(
            "[policy] permission {:?} {title:?} -> {outcome}",
            self.config.permissions
        );
        responder.respond(outcome)?;
        Ok(Handled::Yes)
    }
}

fn inner_method(params: &Value) -> Option<&str> {
    params.get("method").and_then(Value::as_str)
}

fn inner_method_in(params: &Value, allowed: &[&str]) -> bool {
    inner_method(params).is_some_and(|m| allowed.contains(&m))
}

/// The application may not grant itself file or terminal access on the
/// gateway side, whatever it advertises.
fn restrict_client_capabilities(params: &mut Value) {
    if let Some(obj) = params.as_object_mut() {
        obj.insert(
            "clientCapabilities".into(),
            json!({ "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false }),
        );
    }
}

fn filter_tool_list(mut listed: Value, config: &PolicyConfig) -> Value {
    let Some(tools) = listed.get_mut("tools").and_then(Value::as_array_mut) else {
        return listed;
    };
    match &config.snapshot {
        None => {
            let recorded: BTreeMap<_, _> = tools
                .iter()
                .filter_map(|t| {
                    Some((
                        t.get("name")?.as_str()?.to_string(),
                        t.get("inputSchema")?.clone(),
                    ))
                })
                .collect();
            eprintln!(
                "[policy] record-mode snapshot: {}",
                serde_json::to_string(&recorded).unwrap_or_default()
            );
        }
        Some(snapshot) => tools.retain_mut(|tool| {
            let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
            let ok = snapshot
                .get(name)
                .is_some_and(|schema| Some(schema) == tool.get("inputSchema"));
            if !ok {
                eprintln!("[policy] tools/list dropped {name} (not in snapshot or schema drift)");
            }
            if ok {
                if let Some(definitions) = &config.tool_definitions {
                    let Some(approved) = definitions.get(name) else {
                        return false;
                    };
                    *tool = approved.clone();
                }
            }
            ok
        }),
    }
    listed
}

/// Test-only proxy placed after the policy proxy: logs what actually reaches
/// the harness side, so negative tests can show what the policy removed.
pub struct SpyProxy;

impl ConnectTo<Conductor> for SpyProxy {
    async fn connect_to(
        self,
        client: impl ConnectTo<Proxy>,
    ) -> Result<(), agent_client_protocol::Error> {
        Proxy
            .builder()
            .name("spy")
            .with_handler(SpyHandler)
            .connect_to(client)
            .await
    }
}

struct SpyHandler;

impl HandleDispatchFrom<Conductor> for SpyHandler {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        cx: ConnectionTo<Conductor>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        if let Dispatch::Request(request, _) = &message {
            match request.method() {
                METHOD_INITIALIZE_PROXY => eprintln!(
                    "[spy] initialize clientCapabilities={}",
                    request
                        .params
                        .get("clientCapabilities")
                        .unwrap_or(&Value::Null)
                ),
                "session/new" => eprintln!(
                    "[spy] session/new cwd={} mcpServers={}",
                    request.params["cwd"], request.params["mcpServers"]
                ),
                _ => {}
            }
        }
        let _ = cx;
        Ok(Handled::No {
            message,
            retry: false,
        })
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "spy"
    }
}

/// Journals contain lifecycle evidence only, never application arguments/results.
/// No entry is replayed. Pending/uncertain entries survive cleanup and consume capacity.
const ACTION_TTL_MILLIS: u64 = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_ACTIONS: usize = 1024;
const MAX_UNRESOLVED_ACTIONS: usize = 1024;
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActionStatus {
    Pending,
    Completed,
    Failed,
    Uncertain,
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionRecord {
    version: u8,
    action_id: String,
    created_at_millis: u64,
    updated_at_millis: u64,
    status: ActionStatus,
}
fn now_millis() -> std::io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .map_err(std::io::Error::other)
}
fn write_action(
    dir: &std::path::Path,
    record: &ActionRecord,
    replace: bool,
) -> std::io::Result<()> {
    use std::io::Write;
    let target = dir.join(format!("{}.json", record.action_id));
    let path = if replace {
        dir.join(format!("{}.tmp", uuid::Uuid::new_v4()))
    } else {
        target.clone()
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    let written = (|| {
        file.write_all(&serde_json::to_vec(record)?)?;
        file.sync_all()?;
        if replace {
            std::fs::rename(&path, &target)?;
        }
        std::fs::File::open(dir)?.sync_all()
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(path);
    }
    written
}
fn prune_actions(dir: &std::path::Path, now: u64) -> std::io::Result<usize> {
    let mut terminal = Vec::new();
    let mut unresolved = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if !entry.file_type()?.is_file() {
            return Err(std::io::Error::other("invalid action journal entry"));
        }
        let record: ActionRecord = serde_json::from_slice(&std::fs::read(&path)?)?;
        if record.version != 1
            || path.file_stem().and_then(|p| p.to_str()) != Some(record.action_id.as_str())
        {
            return Err(std::io::Error::other("invalid action journal record"));
        }
        match record.status {
            ActionStatus::Pending | ActionStatus::Uncertain => unresolved += 1,
            ActionStatus::Completed | ActionStatus::Failed => {
                terminal.push((record.updated_at_millis, path))
            }
        }
    }
    terminal.sort_by_key(|(updated, _)| *updated);
    let excess = terminal.len().saturating_sub(MAX_TERMINAL_ACTIONS);
    for (index, (updated, path)) in terminal.into_iter().enumerate() {
        if index < excess || now.saturating_sub(updated) >= ACTION_TTL_MILLIS {
            std::fs::remove_file(path)?;
        }
    }
    std::fs::File::open(dir)?.sync_all()?;
    Ok(unresolved)
}
fn persist_action(dir: &std::path::Path, id: &str) -> std::io::Result<()> {
    let _guard = JOURNAL_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("action journal lock"))?;
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let now = now_millis()?;
    if prune_actions(dir, now)? >= MAX_UNRESOLVED_ACTIONS {
        return Err(std::io::Error::other(
            "unresolved action capacity exhausted",
        ));
    }
    write_action(
        dir,
        &ActionRecord {
            version: 1,
            action_id: id.into(),
            created_at_millis: now,
            updated_at_millis: now,
            status: ActionStatus::Pending,
        },
        false,
    )
}
fn finish_action(dir: &std::path::Path, id: &str, status: ActionStatus) -> std::io::Result<()> {
    let _guard = JOURNAL_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("action journal lock"))?;
    let mut record: ActionRecord =
        serde_json::from_slice(&std::fs::read(dir.join(format!("{id}.json")))?)?;
    if record.version != 1 || record.action_id != id {
        return Err(std::io::Error::other("invalid action journal record"));
    }
    record.status = status;
    record.updated_at_millis = now_millis()?;
    write_action(dir, &record, true)?;
    prune_actions(dir, record.updated_at_millis)?;
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod unit_tests {
    use super::*;
    #[test]
    fn setup_removes_authority_and_foreign_servers() {
        let handler = PolicyHandler {
            config: Arc::new(PolicyConfig {
                workspace: "/safe".into(),
                app_server_name: "app".into(),
                snapshot: Some(BTreeMap::new()),
                tool_definitions: None,
                permissions: PermissionProfile::DenyAll,
                grant_sessions: Default::default(),
                actions_dir: None,
            }),
            state: Default::default(),
        };
        let mut params = json!({"cwd":"/secret","model":"other","mode":"unsafe","_meta":{"escape":true},"mcpServers":[{"type":"http","url":"http://localhost"},{"type":"acp","name":"app","serverId":"tools"}]});
        handler.admit_session_setup(&mut params, "session/new", &"/safe".into());
        assert_eq!(
            params,
            json!({"cwd":"/safe","mcpServers":[{"type":"acp","name":"app","serverId":"tools"}]})
        );
    }
    #[test]
    fn journal_never_overwrites_an_action() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        persist_action(&dir, "action").unwrap();
        let original = std::fs::read(dir.join("action.json")).unwrap();
        assert!(persist_action(&dir, "action").is_err());
        assert_eq!(std::fs::read(dir.join("action.json")).unwrap(), original);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
