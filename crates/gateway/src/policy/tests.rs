//! Controlled ACP contract fixtures exercise the real proxy handlers. They
//! assert gateway-owned policy, not adapter compatibility or native event shapes.
use super::*;
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};

type Results = Arc<Mutex<Vec<Result<Value, agent_client_protocol::Error>>>>;
#[derive(Clone)]
struct ProbeAgent {
    results: Results,
    setup: Arc<Mutex<Value>>,
}
impl ConnectTo<Client> for ProbeAgent {
    async fn connect_to(
        self,
        client: impl ConnectTo<Agent>,
    ) -> Result<(), agent_client_protocol::Error> {
        Agent
            .builder()
            .name("policy-contract-agent")
            .with_handler(self)
            .connect_to(client)
            .await
    }
}
impl HandleDispatchFrom<Client> for ProbeAgent {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        cx: ConnectionTo<Client>,
    ) -> Outcome {
        match message {
            Dispatch::Request(request, responder) => match request.method() {
                "initialize" => {
                    responder.respond(json!({"protocolVersion":1,"agentCapabilities":{}}))?;
                    Ok(Handled::Yes)
                }
                "session/new" => {
                    *self.setup.lock().unwrap() = request.params;
                    responder.respond(json!({"sessionId":"owned"}))?;
                    Ok(Handled::Yes)
                }
                "session/prompt" => {
                    let results = self.results.clone();
                    if let Some(updates) = request.params["probe"]
                        .get("updates")
                        .and_then(Value::as_array)
                    {
                        for update in updates {
                            cx.send_notification(UntypedMessage::new(
                                "session/update",
                                json!({"sessionId":"owned","update":update}),
                            )?)?;
                        }
                    }
                    let probe = &request.params["probe"];
                    let outgoing =
                        UntypedMessage::new(probe["method"].as_str().unwrap(), &probe["params"])?;
                    cx.send_request(outgoing)
                        .on_receiving_result(async move |result| {
                            results.lock().unwrap().push(result);
                            responder.respond(json!({"stopReason":"end_turn"}))
                        })?;
                    Ok(Handled::Yes)
                }
                _ => {
                    responder.respond(json!({}))?;
                    Ok(Handled::Yes)
                }
            },
            message => pass(message),
        }
    }
    fn describe_chain(&self) -> impl std::fmt::Debug {
        "policy-contract-agent"
    }
}
struct ProbeApp {
    delivered: Arc<Mutex<Vec<Value>>>,
    response: Value,
    journal: Option<PathBuf>,
}
impl HandleDispatchFrom<Agent> for ProbeApp {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        _cx: ConnectionTo<Agent>,
    ) -> Outcome {
        match message {
            Dispatch::Request(request, responder) => {
                if request.params["method"] == "tools/call" {
                    if let Some(dir) = &self.journal {
                        let id = request.params["_meta"]["agent-connect/actionId"]
                            .as_str()
                            .unwrap();
                        let record: ActionRecord = serde_json::from_slice(
                            &std::fs::read(dir.join(format!("{id}.json"))).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(
                            record.status,
                            ActionStatus::Pending,
                            "journal durable before application delivery"
                        );
                        if self
                            .response
                            .get("testJournalFailure")
                            .and_then(Value::as_bool)
                            == Some(true)
                        {
                            // An impossible-to-confuse non-file entry causes controlled
                            // retention failure after the app has observed the request.
                            std::fs::create_dir(dir.join("fault.json")).unwrap();
                        }
                    }
                }
                self.delivered.lock().unwrap().push(request.params);
                if self.response.get("testRpcError").and_then(Value::as_bool) == Some(true) {
                    responder.respond_with_error(agent_client_protocol::Error::internal_error())?;
                } else {
                    responder.respond(self.response.clone())?;
                }
                Ok(Handled::Yes)
            }
            message => pass(message),
        }
    }
    fn describe_chain(&self) -> impl std::fmt::Debug {
        "policy-contract-app"
    }
}
fn config(profile: PermissionProfile) -> PolicyConfig {
    PolicyConfig {
        workspace: "/safe".into(),
        app_server_name: "app".into(),
        snapshot: Some(BTreeMap::from([(
            "approved".into(),
            json!({"type":"object"}),
        )])),
        tool_definitions: None,
        permissions: profile,
        grant_sessions: Default::default(),
        actions_dir: None,
    }
}
async fn run(
    config: PolicyConfig,
    app_response: Value,
    probes: Vec<Value>,
    denied: Vec<&str>,
) -> (Results, Arc<Mutex<Vec<Value>>>, Value) {
    let results: Results = Default::default();
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let setup = Arc::new(Mutex::new(Value::Null));
    let agent = ProbeAgent {
        results: results.clone(),
        setup: setup.clone(),
    };
    let app = ProbeApp {
        delivered: delivered.clone(),
        response: app_response,
        journal: config.actions_dir.clone(),
    };
    let chain = ConductorImpl::new_agent(
        "policy-contract",
        ProxiesAndAgent::new(agent).proxy(PolicyProxy::new(config)),
    );
    let task = Client.builder().name("policy-contract-app").with_handler(app).connect_with(chain, async move |cx: ConnectionTo<Agent>| {
        cx.send_request(UntypedMessage::new("initialize", json!({"protocolVersion":1}))?).block_task().await?;
        cx.send_request(UntypedMessage::new("session/new", json!({"cwd":"/secret","mcpServers":[{"type":"stdio","name":"foreign","command":"bad","args":[],"env":[]},{"type":"acp","name":"app","serverId":"declared"}]}))?).block_task().await?;
        for method in denied {
            assert!(cx.send_request(UntypedMessage::new(method, json!({"sessionId":"owned"}))?).block_task().await.is_err(), "must deny {method}");
        }
        for probe in probes {
            cx.send_request(UntypedMessage::new("session/prompt", json!({"sessionId":"owned","prompt":[],"probe":probe}))?).block_task().await?;
        }
        Ok(())
    });
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("fixture deadline")
        .unwrap();
    let setup = setup.lock().unwrap().clone();
    (results, delivered, setup)
}
fn probe(method: &str, params: Value) -> Value {
    json!({"method":method,"params":params})
}
fn mcp(method: &str, params: Value) -> Value {
    probe(
        "mcp/message",
        json!({"serverId":"declared","method":method,"params":params}),
    )
}

#[tokio::test]
async fn actual_handlers_deny_authority_and_filter_changed_tools() {
    let probes = vec![
        probe("mcp/connect", json!({"serverId":"undeclared"})),
        probe("fs/read_text_file", json!({})),
        probe("fs/write_text_file", json!({})),
        probe("terminal/create", json!({})),
        probe("terminal/output", json!({})),
        probe("terminal/kill", json!({})),
        probe("terminal/release", json!({})),
        probe("terminal/wait_for_exit", json!({})),
        mcp("tools/call", json!({"name":"unapproved","arguments":{}})),
        mcp("tools/list", json!({})),
    ];
    let listed = json!({"tools":[{"name":"approved","inputSchema":{"type":"object","additionalProperties":false}},{"name":"unapproved","inputSchema":{"type":"object"}}]});
    let (results, delivered, setup) = run(
        config(PermissionProfile::DenyAll),
        listed,
        probes,
        vec!["session/set_mode", "session/set_config_option"],
    )
    .await;
    assert_eq!(setup["cwd"], "/safe");
    assert_eq!(setup["mcpServers"].as_array().unwrap().len(), 1);
    let results = results.lock().unwrap();
    assert!(results[..9].iter().all(Result::is_err));
    assert_eq!(results[9].as_ref().unwrap()["tools"], json!([]));
    assert_eq!(
        delivered.lock().unwrap().len(),
        1,
        "only tools/list reached application"
    );
}
#[tokio::test]
async fn each_permission_profile_is_asserted() {
    for (profile, app_tool, wanted) in [
        (PermissionProfile::Sandboxed, false, "yes"),
        (PermissionProfile::DenyAll, true, "no"),
        (PermissionProfile::AppToolsOnly, true, "yes"),
        (PermissionProfile::AppToolsOnly, false, "no"),
    ] {
        let title = if app_tool {
            "mcp.app.approved"
        } else {
            "terminal native"
        };
        let (results, delivered, _) = run(config(profile), json!({}), vec![probe("session/request_permission", json!({"sessionId":"owned","toolCall":{"toolCallId":"call","title":title},"options":[{"kind":"allow_once","optionId":"yes","name":"Allow"},{"kind":"reject_once","optionId":"no","name":"Reject"}]}))], vec![]).await;
        assert_eq!(
            results.lock().unwrap()[0].as_ref().unwrap()["outcome"]["optionId"],
            wanted
        );
        assert!(
            delivered.lock().unwrap().is_empty(),
            "permissions never delegated to app"
        );
    }
}
#[tokio::test]
async fn metadata_and_durable_lifecycle_survive_real_handlers() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    for is_error in [false, true] {
        let mut cfg = config(PermissionProfile::DenyAll);
        cfg.actions_dir = Some(dir.clone());
        let call = probe(
            "mcp/message",
            json!({"serverId":"declared","method":"tools/call","_meta":{"traceparent":"trace"},"params":{"name":"approved","arguments":{"secret":"never journal"},"_meta":{"progressToken":42}}}),
        );
        let (_, delivered, _) = run(
            cfg,
            json!({"isError":is_error,"content":[]}),
            vec![call],
            vec![],
        )
        .await;
        let value = &delivered.lock().unwrap()[0];
        assert_eq!(value["_meta"]["traceparent"], "trace");
        assert_eq!(value["params"]["_meta"]["progressToken"], 42);
        let id = value["_meta"]["agent-connect/actionId"].as_str().unwrap();
        let text = std::fs::read_to_string(dir.join(format!("{id}.json"))).unwrap();
        assert!(!text.contains("secret") && !text.contains("never journal"));
        let record: ActionRecord = serde_json::from_str(&text).unwrap();
        assert_eq!(
            record.status,
            if is_error {
                ActionStatus::Failed
            } else {
                ActionStatus::Completed
            }
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn journal_failure_prevents_application_delivery() {
    let file = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::write(&file, b"not a directory").unwrap();
    let mut cfg = config(PermissionProfile::DenyAll);
    cfg.actions_dir = Some(file.clone());
    let (results, delivered, _) = run(
        cfg,
        json!({}),
        vec![mcp("tools/call", json!({"name":"approved","arguments":{}}))],
        vec![],
    )
    .await;
    assert!(results.lock().unwrap()[0].is_err());
    assert!(delivered.lock().unwrap().is_empty());
    std::fs::remove_file(file).unwrap();
}
#[test]
fn ownership_expires_and_is_bounded() {
    let mut sessions = RecentSessions::default();
    sessions.entries.insert(
        "expired".into(),
        ("/old".into(), Instant::now() - SESSION_TTL),
    );
    assert!(sessions.get("expired").is_none());
    for id in 0..=MAX_SESSIONS {
        sessions.insert(id.to_string(), format!("/workspace/{id}").into());
    }
    assert_eq!(sessions.entries.len(), MAX_SESSIONS);
    assert!(sessions.get("0").is_none());
    assert_eq!(
        sessions.get(&MAX_SESSIONS.to_string()),
        Some(format!("/workspace/{MAX_SESSIONS}").into())
    );
    let other = RecentSessions::default();
    assert!(
        other.entries.is_empty(),
        "ownership partition stays grant-local"
    );
}
#[test]
fn retention_preserves_uncertainty_and_bounds_terminal_records() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).unwrap();
    for (id, status) in [
        ("pending", ActionStatus::Pending),
        ("uncertain", ActionStatus::Uncertain),
        ("completed", ActionStatus::Completed),
        ("failed", ActionStatus::Failed),
    ] {
        write_action(
            &dir,
            &ActionRecord {
                version: 1,
                action_id: id.into(),
                created_at_millis: 0,
                updated_at_millis: 0,
                status,
            },
            false,
        )
        .unwrap();
    }
    assert_eq!(prune_actions(&dir, ACTION_TTL_MILLIS).unwrap(), 2);
    assert!(dir.join("pending.json").exists());
    assert!(dir.join("uncertain.json").exists());
    assert!(!dir.join("completed.json").exists());
    assert!(!dir.join("failed.json").exists());
    for id in 0..=MAX_TERMINAL_ACTIONS {
        write_action(
            &dir,
            &ActionRecord {
                version: 1,
                action_id: id.to_string(),
                created_at_millis: 1,
                updated_at_millis: 1,
                status: ActionStatus::Completed,
            },
            false,
        )
        .unwrap();
    }
    prune_actions(&dir, 2).unwrap();
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        MAX_TERMINAL_ACTIONS + 2
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn uncertain_response_stays_retained_without_replay() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let mut cfg = config(PermissionProfile::DenyAll);
    cfg.actions_dir = Some(dir.clone());
    let (results, delivered, _) = run(
        cfg,
        json!({"testRpcError":true}),
        vec![mcp("tools/call", json!({"name":"approved","arguments":{}}))],
        vec![],
    )
    .await;
    assert!(results.lock().unwrap()[0].is_err());
    assert_eq!(delivered.lock().unwrap().len(), 1);
    let id = delivered.lock().unwrap()[0]["_meta"]["agent-connect/actionId"]
        .as_str()
        .unwrap()
        .to_string();
    let record: ActionRecord =
        serde_json::from_slice(&std::fs::read(dir.join(format!("{id}.json"))).unwrap()).unwrap();
    assert_eq!(record.status, ActionStatus::Uncertain);
    assert_eq!(
        prune_actions(&dir, record.updated_at_millis + ACTION_TTL_MILLIS).unwrap(),
        1
    );
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn attribution_titles_clear_on_terminal_update_and_turn_completion() {
    let permission = json!({"sessionId":"owned","toolCall":{"toolCallId":"app-call","title":""},"options":[{"kind":"allow_once","optionId":"yes","name":"Allow"},{"kind":"reject_once","optionId":"no","name":"Reject"}]});
    let app_update = json!({"sessionUpdate":"tool_call","toolCallId":"app-call","title":"mcp.app.approved","status":"pending"});
    let mut first = probe("session/request_permission", permission.clone());
    first["updates"] = json!([app_update.clone()]);
    let second = probe("session/request_permission", permission.clone());
    let mut terminal = probe("session/request_permission", permission.clone());
    terminal["updates"] = json!([app_update.clone(), {"sessionUpdate":"tool_call_update","toolCallId":"app-call","status":"completed"}]);
    let mut bounded = probe("session/request_permission", permission);
    let mut updates = vec![app_update];
    for id in 0..MAX_TOOL_TITLES {
        updates.push(json!({"sessionUpdate":"tool_call","toolCallId":id.to_string(),"title":"native","status":"pending"}));
    }
    bounded["updates"] = json!(updates);
    let (results, delivered, _) = run(
        config(PermissionProfile::AppToolsOnly),
        json!({}),
        vec![first, second, terminal, bounded],
        vec![],
    )
    .await;
    let choices: Vec<_> = results
        .lock()
        .unwrap()
        .iter()
        .map(|result| {
            result.as_ref().unwrap()["outcome"]["optionId"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(choices, ["yes", "no", "no", "no"]);
    assert!(delivered.lock().unwrap().is_empty());
}
#[tokio::test]
async fn tool_list_uses_only_approved_definition_metadata() {
    let mut cfg = config(PermissionProfile::DenyAll);
    let approved = json!({"name":"approved","description":"Consented description","inputSchema":{"type":"object"}});
    cfg.tool_definitions = Some(BTreeMap::from([("approved".into(), approved.clone())]));
    let listed = json!({"tools":[{"name":"approved","description":"Changed hostile description","annotations":{"readOnlyHint":false},"inputSchema":{"type":"object"}}]});
    let (results, _, _) = run(cfg, listed, vec![mcp("tools/list", json!({}))], vec![]).await;
    assert_eq!(
        results.lock().unwrap()[0].as_ref().unwrap()["tools"],
        json!([approved])
    );
}
#[test]
fn unresolved_capacity_fails_closed_without_deleting_pending() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).unwrap();
    for id in 0..MAX_UNRESOLVED_ACTIONS {
        let record = ActionRecord {
            version: 1,
            action_id: id.to_string(),
            created_at_millis: 0,
            updated_at_millis: 0,
            status: ActionStatus::Pending,
        };
        std::fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
    assert!(persist_action(&dir, "must-not-deliver").is_err());
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        MAX_UNRESOLVED_ACTIONS
    );
    assert!(!dir.join("must-not-deliver.json").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn completion_bookkeeping_fault_preserves_known_application_outcome() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let mut cfg = config(PermissionProfile::DenyAll);
    cfg.actions_dir = Some(dir.clone());
    let known =
        json!({"testJournalFailure":true,"content":[{"type":"text","text":"Effect completed"}]});
    let (results, delivered, _) = run(
        cfg,
        known.clone(),
        vec![mcp("tools/call", json!({"name":"approved","arguments":{}}))],
        vec![],
    )
    .await;
    assert_eq!(results.lock().unwrap()[0].as_ref().unwrap(), &known);
    assert_eq!(
        delivered.lock().unwrap().len(),
        1,
        "no retry after bookkeeping fault"
    );
    let id = delivered.lock().unwrap()[0]["_meta"]["agent-connect/actionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        dir.join(format!("{id}.json")).exists(),
        "durable action evidence retained"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
