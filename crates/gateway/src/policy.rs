//! Agent Connect policy proxy: the only component that sees untrusted
//! application traffic. It is default-deny in both directions and uses only
//! generic ACP and MCP-over-ACP message shapes, never harness-specific events.
//!
//! Chain position: app -> [PolicyProxy] -> McpOverAcpPolyfill -> adapter.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::METHOD_INITIALIZE_PROXY;
use agent_client_protocol::util::MatchDispatchFrom;
use agent_client_protocol::{
    Agent, Client, Conductor, ConnectTo, ConnectionTo, Dispatch, HandleDispatchFrom, Handled,
    Proxy, Responder, UntypedMessage,
};
use serde_json::{Value, json};

/// How the gateway answers harness permission prompts. Prompts are never shown
/// to the application: the application is not the approver for host authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
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
    pub permissions: PermissionProfile,
    /// Sessions created under this grant (session id -> workspace), shared by
    /// every connection that presents the same grant. `session/load` and
    /// `session/resume` are admitted only for these ids, pinned to their
    /// original workspace because harnesses key stored sessions by `cwd`.
    pub grant_sessions: GrantSessions,
    /// Gateway-owned journal, written before an application action is delivered.
    pub actions_dir: Option<PathBuf>,
}

pub type GrantSessions = Arc<Mutex<BTreeMap<String, PathBuf>>>;

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
            .if_dispatch_from(Agent, async |m: Dispatch| self.handle_agent(m, &cx))
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
                    let Some(workspace) =
                        self.config.grant_sessions.lock().unwrap().get(&id).cloned()
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
                    state.prompting = true;
                    drop(state);
                    let state = self.state.clone();
                    cx.send_request_to(Agent, request)
                        .forward_cancellation_from(responder.cancellation())
                        .on_receiving_result(async move |result| {
                            state.lock().unwrap().prompting = false;
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

    fn handle_agent(&self, message: Dispatch, cx: &ConnectionTo<Conductor>) -> Outcome {
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
                "mcp/message" => self.mcp_request_to_app(request, responder, cx),
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
                    if let (Some(id), Some(title)) = (
                        update.get("toolCallId").and_then(Value::as_str),
                        update
                            .get("title")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty()),
                    ) {
                        self.state
                            .lock()
                            .unwrap()
                            .tool_titles
                            .insert(id.to_string(), title.to_string());
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

    fn mcp_request_to_app(
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
                    request.params["_meta"] = json!({"agent-connect/actionId": action_id});
                    if let Some(dir) = &self.config.actions_dir {
                        if let Err(error) = persist_action(dir, &action_id, &request.params) {
                            return deny(
                                responder,
                                agent_client_protocol::Error::internal_error(),
                                &format!("action journal: {error}"),
                            );
                        }
                    }
                    pass(Dispatch::Request(request, responder))
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
        Some(snapshot) => tools.retain(|tool| {
            let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
            let ok = snapshot
                .get(name)
                .is_some_and(|schema| Some(schema) == tool.get("inputSchema"));
            if !ok {
                eprintln!("[policy] tools/list dropped {name} (not in snapshot or schema drift)");
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

/// No journal entry is automatically replayed. A crash leaves an uncertain action.
fn persist_action(dir: &std::path::Path, id: &str, value: &Value) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        options.mode(0o600);
    }
    let mut file = options.open(dir.join(format!("{id}.json")))?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.sync_all()?;
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn setup_removes_authority_and_foreign_servers() {
        let handler = PolicyHandler {
            config: Arc::new(PolicyConfig {
                workspace: "/safe".into(),
                app_server_name: "app".into(),
                snapshot: Some(BTreeMap::new()),
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
        persist_action(&dir, "action", &json!({"name":"highlight"})).unwrap();
        assert!(persist_action(&dir, "action", &json!({})).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
