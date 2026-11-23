//! Agent Connect gateway launch recipes and deterministic compatibility fixtures.
//! ACP and MCP-over-ACP APIs are unstable.

pub mod authorization;
pub mod client_address;
pub mod config;
pub mod credentials;
pub mod engine;
pub mod http_security;
pub mod operations;
pub mod policy;
pub mod resume;
pub mod sandbox;
pub mod telemetry;

use std::path::{Path, PathBuf};

use agent_client_protocol::AcpAgent;
use serde::{Deserialize, Serialize};

/// Directory layout of the deterministic host fixtures. `.run/` is gitignored and
/// holds isolated harness configuration, never personal configuration.
pub struct FixturePaths {
    pub root: PathBuf,
}

impl FixturePaths {
    pub fn from_manifest() -> Self {
        Self {
            root: std::env::var_os("AGENT_CONNECT_TEST_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".")),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Codex,
    Claude,
}

/// Launch recipe for an unmodified adapter pointed at the scripted mock model.
/// `codex_mode` is a codex-acp agent mode (`read-only`, `workspace-write`,
/// `agent`, `agent-full-access`); the operator chooses it, never the app.
pub fn mock_harness(
    paths: &FixturePaths,
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
                (
                    "ANTHROPIC_AUTH_TOKEN".into(),
                    "deterministic-fixture".into(),
                ),
                ("DISABLE_TELEMETRY".into(), "1".into()),
                (
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                    "1".into(),
                ),
            ],
            paths.bin("claude-agent-acp"),
        ),
    };
    let args = [
        "env".to_string(),
        "-i".to_string(),
        format!("PATH={}", std::env::var("PATH").unwrap_or_default()),
        format!("HOME={}", path(&run)),
        "LANG=C.UTF-8".to_string(),
    ]
    .into_iter()
    .chain(
        env.into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .chain(std::iter::once(path(&bin))),
    );
    AcpAgent::from_args(args).expect("valid adapter command")
}

fn path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
