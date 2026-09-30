//! Shared pieces of the ACP gateway spike: harness launch recipes and the
//! application tool fixture that stands in for a browser page.

pub mod policy;

use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_client_protocol::AcpAgent;
use agent_client_protocol::mcp_server::McpServer;
use agent_client_protocol_rmcp::McpServerExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Directory layout used by every spike binary. `.run/` is gitignored and
/// holds isolated harness configuration, never personal configuration.
pub struct SpikePaths {
    pub root: PathBuf,
}

impl SpikePaths {
    pub fn from_manifest() -> Self {
        Self {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        }
    }
    pub fn run_dir(&self) -> PathBuf {
        self.root.join(".run")
    }
    pub fn workspace(&self) -> PathBuf {
        self.run_dir().join("workspace")
    }
    fn bin(&self, name: &str) -> PathBuf {
        self.root.join("adapters/node_modules/.bin").join(name)
    }
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum Harness {
    Codex,
    Claude,
}

/// Launch recipe for an unmodified adapter pointed at the scripted mock model.
/// `codex_mode` is a codex-acp agent mode (`read-only`, `workspace-write`,
/// `agent`, `agent-full-access`); the operator chooses it, never the app.
pub fn mock_harness(
    paths: &SpikePaths,
    harness: Harness,
    mock_url: &str,
    codex_mode: &str,
) -> AcpAgent {
    let run = paths.run_dir();
    let (env, bin): (Vec<(String, String)>, PathBuf) = match harness {
        Harness::Codex => (
            vec![
                (
                    "CODEX_HOME".into(),
                    std::env::var("SPIKE_CODEX_HOME")
                        .unwrap_or_else(|_| path(&run.join("codex-home"))),
                ),
                ("INITIAL_AGENT_MODE".into(), codex_mode.into()),
            ],
            paths.bin("codex-acp"),
        ),
        Harness::Claude => (
            vec![
                ("CLAUDE_CONFIG_DIR".into(), path(&run.join("claude-config"))),
                (
                    "ANTHROPIC_BASE_URL".into(),
                    mock_url.trim_end_matches("/v1").into(),
                ),
                ("ANTHROPIC_API_KEY".into(), "sk-spike-dummy".into()),
                ("DISABLE_TELEMETRY".into(), "1".into()),
                (
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                    "1".into(),
                ),
            ],
            paths.bin("claude-agent-acp"),
        ),
    };
    let args = env
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .chain(std::iter::once(path(&bin)));
    AcpAgent::from_args(args).expect("valid adapter command")
}

fn path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ------------------------------------------------------------ app tools ---

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadPassageParams {
    /// Chapter number, starting at 1.
    pub chapter: u32,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ReadPassageOutput {
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct HighlightParams {
    /// Exact passage text to highlight in the reader.
    pub text: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct HighlightOutput {
    pub highlighted: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AskReaderParams {
    /// Question shown to the reader; the call waits for their answer.
    pub question: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct AskReaderOutput {
    pub answer: String,
}

/// The application's MCP server, as a page would offer it. `ask_delay`
/// simulates a person taking time to answer.
pub fn app_tools<Counterpart>(
    ask_delay: Duration,
) -> McpServer<Counterpart, impl agent_client_protocol::RunWithConnectionTo<Counterpart>>
where
    Counterpart: agent_client_protocol::Role,
{
    McpServer::builder("app")
        .tool_fn(
            "read_passage",
            "Read the opening passage of a chapter of the open book.",
            async |p: ReadPassageParams, _cx| {
                eprintln!("[app] read_passage({})", p.chapter);
                Ok(ReadPassageOutput {
                    text: format!(
                        "Chapter {}: The validation set is not the test set.",
                        p.chapter
                    ),
                })
            },
            agent_client_protocol::tool_fn!(),
        )
        .tool_fn(
            "highlight",
            "Highlight exact passage text in the reader.",
            async |p: HighlightParams, _cx| {
                eprintln!("[app] highlight({:?})", p.text);
                Ok(HighlightOutput {
                    highlighted: p.text,
                })
            },
            agent_client_protocol::tool_fn!(),
        )
        .tool_fn(
            "ask_reader",
            "Ask the reader a question and wait for their answer.",
            async move |p: AskReaderParams, _cx| {
                eprintln!("[app] ask_reader({:?}) waiting {:?}", p.question, ask_delay);
                tokio::time::sleep(ask_delay).await;
                Ok(AskReaderOutput {
                    answer: "Chapter 3, please.".into(),
                })
            },
            agent_client_protocol::tool_fn!(),
        )
        .build()
}

/// Launch recipe for a per-session container (Phase 6). The box holds the
/// polyfill and the adapter; its only network exit is the egress proxy.
/// `codex_mode` defaults to full access inside the box: the box, not the
/// harness, is the boundary.
pub fn boxed_harness(harness: Harness, session: &str, codex_mode: &str) -> AcpAgent {
    let name = match harness {
        Harness::Codex => "codex",
        Harness::Claude => "claude",
    };
    let proxy = "http://egress:3128";
    let no_proxy = "mock,localhost,127.0.0.1";
    let mut args: Vec<String> = [
        "docker",
        "run",
        "-i",
        "--rm",
        "--name",
        &format!("acp-sess-{session}"),
        "--network",
        "acp-internal",
        "--read-only",
        "--tmpfs",
        "/work:rw,exec,size=512m,uid=1000,gid=1000",
        "--tmpfs",
        "/home/node:rw,exec,size=512m,uid=1000,gid=1000",
        "--tmpfs",
        "/tmp:rw,exec,size=256m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "1536m",
        "--cpus",
        "2",
        "--pids-limit",
        "512",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for (k, v) in [
        ("HTTPS_PROXY", proxy),
        ("HTTP_PROXY", proxy),
        ("NO_PROXY", no_proxy),
        ("https_proxy", proxy),
        ("http_proxy", proxy),
        ("no_proxy", no_proxy),
        ("NODE_USE_ENV_PROXY", "1"),
        ("INITIAL_AGENT_MODE", codex_mode),
        ("ANTHROPIC_BASE_URL", "http://mock:18931"),
        ("ANTHROPIC_API_KEY", "sk-spike-dummy"),
        ("DISABLE_TELEMETRY", "1"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
    ] {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    args.extend([
        "acp-spike-session:dev".into(),
        "--harness".into(),
        name.into(),
    ]);
    AcpAgent::from_args(args).expect("valid docker command")
}

/// Phase 7 live smoke: an unmodified adapter on the host using the owner's
/// existing harness login in place (default configuration directories under
/// `HOME`, nothing copied). This is not a security boundary: it exists to prove
/// real-model composition. The adapter starts from an empty environment plus an
/// explicit allowlist, so no variables from the calling session (for example a
/// parent Claude Code session's messaging socket) leak into the harness.
pub fn live_harness(paths: &SpikePaths, harness: Harness, codex_mode: &str) -> AcpAgent {
    let bin = match harness {
        Harness::Codex => paths.bin("codex-acp"),
        Harness::Claude => paths.bin("claude-agent-acp"),
    };
    let keep = |name: &str| format!("{name}={}", std::env::var(name).unwrap_or_default());
    AcpAgent::from_args([
        "env".into(),
        "-i".into(),
        keep("PATH"),
        keep("HOME"),
        keep("USER"),
        "LANG=C.UTF-8".into(),
        format!("INITIAL_AGENT_MODE={codex_mode}"),
        path(&bin),
    ])
    .expect("valid adapter command")
}
