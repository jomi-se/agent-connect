//! Per-session containers. The container, not harness prompts, bounds native actions.
use crate::{Harness, credentials::HarnessHome};
use anyhow::{Context, bail};

pub fn box_args(
    harness: Harness,
    session: &str,
    mode: &str,
    volume: Option<&str>,
    home: Option<&HarnessHome>,
    image: &str,
    network: &str,
    mock: bool,
) -> Vec<String> {
    let (uid, gid) = home.map(|h| (h.uid, h.gid)).unwrap_or((1000, 1000));
    let mut args: Vec<String> = [
        "docker",
        "run",
        "-i",
        "--rm",
        "--name",
        &format!("acp-sess-{session}"),
        "--network",
        network,
        "--read-only",
        "--tmpfs",
        &format!("/work:rw,exec,size=512m,uid={uid},gid={gid}"),
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
    if let Some(home) = home {
        args.extend(home.docker_args());
    } else if let Some(volume) = volume {
        args.extend(["-v".into(), format!("{volume}:/home/node")]);
    } else {
        args.extend([
            "--tmpfs".into(),
            "/home/node:rw,exec,size=512m,uid=1000,gid=1000".into(),
        ]);
    }
    for (key, value) in [
        ("HTTPS_PROXY", "http://egress:3128"),
        ("HTTP_PROXY", "http://egress:3128"),
        ("https_proxy", "http://egress:3128"),
        ("http_proxy", "http://egress:3128"),
        ("NO_PROXY", "localhost,127.0.0.1"),
        ("NODE_USE_ENV_PROXY", "1"),
        ("INITIAL_AGENT_MODE", mode),
        ("DISABLE_TELEMETRY", "1"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
    ] {
        args.extend(["-e".into(), format!("{key}={value}")]);
    }
    if mock {
        // Synthetic local authentication, never a provider credential or API key.
        for (key, value) in [
            ("AGENT_CONNECT_MOCK_MODEL", "1"),
            ("ANTHROPIC_BASE_URL", "http://mock:18931"),
            ("ANTHROPIC_AUTH_TOKEN", "deterministic-fixture"),
            ("NO_PROXY", "mock,localhost,127.0.0.1"),
            ("no_proxy", "mock,localhost,127.0.0.1"),
        ] {
            args.extend(["-e".into(), format!("{key}={value}")]);
        }
    }
    args.extend([
        image.into(),
        "--harness".into(),
        match harness {
            Harness::Codex => "codex",
            Harness::Claude => "claude",
        }
        .into(),
    ]);
    args
}

/// A session gets its own internal network, shared only with the selected egress
/// proxy and, in deterministic tests, a mock model. Cleanup owns only this network.
pub struct SessionNetwork {
    pub name: String,
    peers: Vec<String>,
}
impl SessionNetwork {
    pub fn create(session: &str, egress: &str, mock: Option<&str>) -> anyhow::Result<Self> {
        let name = format!("acp-sess-net-{session}");
        docker(&["network", "create", "--internal", &name])?;
        let mut network = Self {
            name,
            peers: Vec::new(),
        };
        for (peer, alias) in std::iter::once((egress, "egress")).chain(mock.map(|m| (m, "mock"))) {
            docker(&["network", "connect", "--alias", alias, &network.name, peer])?;
            network.peers.push(peer.into());
        }
        Ok(network)
    }
}
impl Drop for SessionNetwork {
    fn drop(&mut self) {
        for peer in &self.peers {
            let _ = docker(&["network", "disconnect", "--force", &self.name, peer]);
        }
        let _ = docker(&["network", "rm", &self.name]);
    }
}
fn docker(args: &[&str]) -> anyhow::Result<()> {
    let output = std::process::Command::new("docker")
        .args(args)
        .output()
        .context("Docker is required for boxed sessions")?;
    if !output.status.success() {
        bail!(
            "Docker operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boxes_never_receive_api_key_variables() {
        for mock in [false, true] {
            let args = box_args(
                Harness::Claude,
                "test",
                "workspace-write",
                None,
                None,
                "session:test",
                "network-test",
                mock,
            );
            assert!(!args.iter().any(|arg| arg.contains("API_KEY")));
            assert_eq!(args.iter().any(|arg| arg.contains("AUTH_TOKEN")), mock);
            assert_eq!(args.iter().any(|arg| arg.contains("BASE_URL")), mock);
            assert!(args.contains(&"--read-only".into()));
            assert!(args.contains(&"no-new-privileges".into()));
        }
    }
}
