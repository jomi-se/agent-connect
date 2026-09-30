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
                ("CODEX_HOME".into(), path(&run.join("codex-home"))),
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
