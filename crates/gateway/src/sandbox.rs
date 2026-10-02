//! Per-session containers. The container, not harness prompts, bounds native actions.
use crate::{Harness, credentials::HarnessHome};
use anyhow::{Context, bail};

const EGRESS_LABEL: &str = "org.agent-connect.component";
const EGRESS_OWNER: &str = "acp-egress";

pub fn egress_start_args(name: &str, image: &str) -> Vec<String> {
    [
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        &format!("{EGRESS_LABEL}={EGRESS_OWNER}"),
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory=256m",
        "--cpus=1",
        "--pids-limit=64",
        "--entrypoint",
        "node",
        image,
        "/opt/agent-connect/egress-proxy.mjs",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub fn egress_start(name: &str, image: &str) -> anyhow::Result<()> {
    crate::config::validate_container_name(name)?;
    let args = egress_start_args(name, image);
    docker(&args.iter().map(String::as_str).collect::<Vec<_>>())
}

pub fn egress_stop(name: &str) -> anyhow::Result<()> {
    crate::config::validate_container_name(name)?;
    let output = std::process::Command::new("docker")
        .args(["inspect", "--type", "container", name])
        .output()
        .context("Docker is required to stop the egress proxy")?;
    if !output.status.success() {
        bail!("cannot inspect egress container; nothing was removed");
    }
    let containers: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).context("invalid Docker container inspection")?;
    let container = containers
        .first()
        .filter(|_| containers.len() == 1)
        .ok_or_else(|| anyhow::anyhow!("expected one egress container; nothing was removed"))?;
    if container
        .pointer("/Config/Labels")
        .and_then(|v| v.get(EGRESS_LABEL))
        .and_then(|v| v.as_str())
        != Some(EGRESS_OWNER)
    {
        bail!("container is not labelled as an Agent Connect egress proxy; nothing was removed");
    }
    // Remove the inspected immutable ID so a concurrent name replacement cannot
    // cause deletion of a different, unowned container.
    let id = container
        .get("Id")
        .and_then(|v| v.as_str())
        .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow::anyhow!("invalid inspected container ID; nothing was removed"))?;
    docker(&["rm", "--force", id])
}

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
    fn egress_uses_same_image_without_host_port_or_credentials() {
        let args = egress_start_args("owned-egress", "session:test");
        assert!(args.contains(&"--read-only".into()));
        assert!(args.contains(&format!("{EGRESS_LABEL}={EGRESS_OWNER}")));
        assert!(args.ends_with(&[
            "node".into(),
            "session:test".into(),
            "/opt/agent-connect/egress-proxy.mjs".into()
        ]));
        assert!(
            !args
                .iter()
                .any(|a| a == "-p" || a.contains("publish") || a.contains("API_KEY"))
        );
    }
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
