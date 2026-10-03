//! Per-session containers. The container, not harness prompts, bounds native actions.
use crate::{Harness, credentials::HarnessHome};
use anyhow::{Context, bail};
use std::time::{Duration, Instant};

const SESSION_LABEL: &str = "org.agent-connect.session";
const SESSION_OWNER: &str = "acp-session";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(8);

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
        "--restart=unless-stopped",
        "--log-driver=json-file",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
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
    egress_start_with(name, image, &mut Docker)
}

fn egress_start_with(
    name: &str,
    image: &str,
    docker: &mut impl DockerCommand,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let image = inspect_image(image, docker, deadline)?;
    match inspect_container(name, docker, deadline)? {
        Some(container) => {
            let id = validate_egress(&container, &image, false)?;
            if container
                .pointer("/State/Running")
                .and_then(|v| v.as_bool())
                != Some(true)
            {
                docker.run(&["start", &id], deadline).context(
                    "could not start owned egress proxy; inspect Docker state before retrying",
                )?;
            }
            // Inspect the captured ID, never the possibly reused name.
            let running = inspect_container(&id, docker, deadline)?.ok_or_else(|| {
                anyhow::anyhow!("owned egress proxy disappeared while starting; rerun egress start")
            })?;
            validate_egress(&running, &image, true)?;
        }
        None => {
            let args = egress_start_args(name, &image.id);
            docker.run(&args.iter().map(String::as_str).collect::<Vec<_>>(), deadline)
                .context("could not create egress proxy; check Docker and any conflicting container name")?;
        }
    }
    Ok(())
}

/// Read-only production prerequisite check. Call from a blocking lane before
/// listening; serve never starts a missing/stopped proxy implicitly.
pub fn preflight(image: &str, egress: &str) -> anyhow::Result<()> {
    crate::config::validate_container_name(egress)?;
    preflight_with(image, egress, &mut Docker)
}
fn preflight_with(
    image: &str,
    egress: &str,
    docker: &mut impl DockerCommand,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let image = inspect_image(image, docker, deadline)?;
    checked_egress(egress, &image, docker, deadline)?;
    Ok(())
}

struct SessionImage {
    id: String,
    env: serde_json::Value,
    user: serde_json::Value,
}
fn inspect_image(
    image: &str,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> anyhow::Result<SessionImage> {
    let output = docker.run(&["image", "inspect", "--format", "{{json .}}", image], deadline)
        .context("selected session image is unavailable; Docker must be running and the selected image installed before egress start or serve")?;
    let value: serde_json::Value =
        serde_json::from_str(&output).context("invalid Docker image inspection")?;
    let id = value
        .get("Id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing inspected image ID"))?;
    docker_id(id.strip_prefix("sha256:").unwrap_or(id))?;
    Ok(SessionImage {
        id: id.into(),
        env: value
            .pointer("/Config/Env")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        user: value
            .pointer("/Config/User")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    })
}
fn inspect_container(
    name: &str,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> anyhow::Result<Option<serde_json::Value>> {
    match docker.run(
        &[
            "inspect",
            "--type",
            "container",
            "--format",
            "{{json .}}",
            name,
        ],
        deadline,
    ) {
        Ok(output) => Ok(Some(
            serde_json::from_str(&output).context("invalid Docker egress inspection")?,
        )),
        Err(error) if missing_resource(&error) => Ok(None),
        Err(error) => Err(error)
            .context("cannot inspect egress proxy; check that Docker is running and accessible"),
    }
}
fn checked_egress(
    name: &str,
    image: &SessionImage,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> anyhow::Result<String> {
    let container = inspect_container(name, docker, deadline)?
        .ok_or_else(|| anyhow::anyhow!("egress proxy is absent; run agent-connect egress start with the configured name and session image"))?;
    validate_egress(&container, image, true)
}
fn validate_egress(
    container: &serde_json::Value,
    image: &SessionImage,
    running: bool,
) -> anyhow::Result<String> {
    use serde_json::json;
    if container
        .pointer("/Config/Labels")
        .and_then(|v| v.get(EGRESS_LABEL))
        .and_then(|v| v.as_str())
        != Some(EGRESS_OWNER)
    {
        bail!("container is not labelled as an Agent Connect egress proxy; nothing was changed");
    }
    let id = docker_id(
        container
            .get("Id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing egress container ID"))?,
    )?;
    let empty = |value: Option<&serde_json::Value>| {
        value.is_none_or(|v| {
            v.is_null()
                || v.as_array().is_some_and(Vec::is_empty)
                || v.as_object().is_some_and(serde_json::Map::is_empty)
        })
    };
    let trusted = container.get("Image").and_then(|v| v.as_str()) == Some(image.id.as_str())
        && container.pointer("/Config/Entrypoint") == Some(&json!(["node"]))
        && container.pointer("/Config/Cmd")
            == Some(&json!(["/opt/agent-connect/egress-proxy.mjs"]))
        && container.pointer("/Config/Env") == Some(&image.env)
        && container
            .pointer("/Config/User")
            .unwrap_or(&serde_json::Value::Null)
            == &image.user
        && container
            .pointer("/HostConfig/ReadonlyRootfs")
            .and_then(|v| v.as_bool())
            == Some(true)
        && container
            .pointer("/HostConfig/Privileged")
            .and_then(|v| v.as_bool())
            == Some(false)
        && container
            .pointer("/HostConfig/Memory")
            .and_then(|v| v.as_u64())
            == Some(256 * 1024 * 1024)
        && container
            .pointer("/HostConfig/NanoCpus")
            .and_then(|v| v.as_u64())
            == Some(1_000_000_000)
        && container
            .pointer("/HostConfig/PidsLimit")
            .and_then(|v| v.as_u64())
            == Some(64)
        && container.pointer("/HostConfig/CapDrop") == Some(&json!(["ALL"]))
        && container.pointer("/HostConfig/SecurityOpt") == Some(&json!(["no-new-privileges"]))
        && empty(container.pointer("/HostConfig/CapAdd"))
        && empty(container.pointer("/HostConfig/Devices"))
        && empty(container.pointer("/HostConfig/DeviceRequests"))
        && container
            .pointer("/HostConfig/PidMode")
            .and_then(|v| v.as_str())
            != Some("host")
        && container
            .pointer("/HostConfig/IpcMode")
            .and_then(|v| v.as_str())
            != Some("host")
        && empty(container.pointer("/HostConfig/Binds"))
        && empty(container.get("Mounts"))
        && empty(container.pointer("/HostConfig/PortBindings"))
        && container
            .pointer("/HostConfig/NetworkMode")
            .and_then(|v| v.as_str())
            != Some("host")
        && container
            .pointer("/HostConfig/RestartPolicy/Name")
            .and_then(|v| v.as_str())
            == Some("unless-stopped")
        && container
            .pointer("/HostConfig/LogConfig/Type")
            .and_then(|v| v.as_str())
            == Some("json-file")
        && container
            .pointer("/HostConfig/LogConfig/Config/max-size")
            .and_then(|v| v.as_str())
            == Some("10m")
        && container
            .pointer("/HostConfig/LogConfig/Config/max-file")
            .and_then(|v| v.as_str())
            == Some("3");
    if !trusted {
        bail!(
            "owned egress proxy does not match the selected image and restricted proxy configuration; explicitly stop it and recreate it with agent-connect egress start"
        );
    }
    if running
        && (container
            .pointer("/State/Running")
            .and_then(|v| v.as_bool())
            != Some(true)
            || container
                .pointer("/State/Restarting")
                .and_then(|v| v.as_bool())
                == Some(true)
            || container
                .pointer("/State/Health/Status")
                .and_then(|v| v.as_str())
                == Some("unhealthy"))
    {
        bail!(
            "owned egress proxy is stopped, restarting or unhealthy; run agent-connect egress start and inspect its bounded Docker logs"
        );
    }
    Ok(id)
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
        "--label",
        &format!("{EGRESS_LABEL}={SESSION_OWNER}"),
        "--label",
        &format!("{SESSION_LABEL}={session}"),
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

/// Owns the immutable Docker IDs allocated for one session. Shared peers are
/// disconnected, never removed. All Docker work runs on a blocking lane.
pub struct SessionNetwork {
    pub name: String,
    session: String,
    id: Option<String>,
    container: Option<String>,
    peers: Vec<String>,
    cleanup_on_drop: bool,
    capacity: Option<tokio::sync::OwnedSemaphorePermit>,
    startup_deadline: Instant,
    image_id: Option<String>,
}
impl SessionNetwork {
    pub fn create(
        session: &str,
        egress: &str,
        mock: Option<&str>,
        image: &str,
        capacity: tokio::sync::OwnedSemaphorePermit,
    ) -> anyhow::Result<Self> {
        Self::create_with(session, egress, mock, image, Some(capacity), &mut Docker)
    }

    fn create_with(
        session: &str,
        egress: &str,
        mock: Option<&str>,
        image: &str,
        capacity: Option<tokio::sync::OwnedSemaphorePermit>,
        docker: &mut impl DockerCommand,
    ) -> anyhow::Result<Self> {
        let name = format!("acp-sess-net-{session}");
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut network = Self {
            name,
            session: session.into(),
            id: None,
            container: None,
            peers: Vec::new(),
            cleanup_on_drop: true,
            capacity,
            startup_deadline: deadline,
            image_id: None,
        };
        let result = (|| {
            match docker
                .run(
                    &[
                        "network",
                        "create",
                        "--internal",
                        "--label",
                        &format!("{EGRESS_LABEL}={SESSION_OWNER}"),
                        "--label",
                        &format!("{SESSION_LABEL}={session}"),
                        &network.name,
                    ],
                    deadline,
                )
                .and_then(|output| docker_id(&output))
            {
                Ok(id) => network.id = Some(id),
                Err(error) => {
                    network.recover_created_id("network", docker);
                    return Err(error);
                }
            }
            for (peer, alias) in
                std::iter::once((egress, "egress")).chain(mock.map(|m| (m, "mock")))
            {
                let (id, selected_image) = if alias == "egress" {
                    let image = inspect_image(image, docker, deadline)?;
                    let id = checked_egress(peer, &image, docker, deadline)?;
                    network.image_id = Some(image.id.clone());
                    (id, Some(image))
                } else {
                    (
                        docker_id(&docker.run(
                            &[
                                "inspect",
                                "--type",
                                "container",
                                "--format",
                                "{{.Id}}",
                                peer,
                            ],
                            deadline,
                        )?)?,
                        None,
                    )
                };
                // Record before connecting: even an uncertain connect failure must
                // roll back this exact peer, never a later replacement of its name.
                network.peers.push(id.clone());
                docker.run(
                    &[
                        "network",
                        "connect",
                        "--alias",
                        alias,
                        network.id.as_deref().unwrap(),
                        &id,
                    ],
                    deadline,
                )?;
                if let Some(image) = selected_image {
                    checked_egress(&id, &image, docker, deadline)?;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            if let Err(cleanup) = network.cleanup_with(docker) {
                tracing::error!(%cleanup, "session network startup rollback failed");
            }
            network.cleanup_on_drop = false;
            return Err(error);
        }
        Ok(network)
    }

    /// Allocate the box before attaching so teardown owns its immutable ID,
    /// even if Docker start or adapter initialization fails.
    pub fn create_box(&mut self, args: Vec<String>) -> anyhow::Result<Vec<String>> {
        self.create_box_with(args, &mut Docker)
    }

    fn create_box_with(
        &mut self,
        mut args: Vec<String>,
        docker: &mut impl DockerCommand,
    ) -> anyhow::Result<Vec<String>> {
        args[1] = "create".into();
        // Use the captured network ID; a name can be reused concurrently.
        let network_arg = args.iter().position(|arg| arg == "--network").unwrap() + 1;
        args[network_arg] = self.id.as_ref().unwrap().clone();
        if let Some(image) = &self.image_id {
            let image_arg = args.len() - 3; // box_args ends with image, --harness, name.
            args[image_arg] = image.clone();
        }
        match docker
            .run(
                &args[1..].iter().map(String::as_str).collect::<Vec<_>>(),
                self.startup_deadline,
            )
            .and_then(|output| docker_id(&output))
        {
            Ok(id) => self.container = Some(id),
            Err(error) => {
                self.recover_created_id("container", docker);
                return Err(error);
            }
        }
        Ok(vec![
            "docker".into(),
            "start".into(),
            "--attach".into(),
            "--interactive".into(),
            self.container.as_ref().unwrap().clone(),
        ])
    }

    /// A failed/timed-out CLI response can follow successful daemon allocation.
    /// Reconcile that uncertainty by labels, capture its ID, then tear down by ID.
    /// Never treat a reused name alone as ownership evidence.
    fn recover_created_id(&mut self, kind: &str, docker: &mut impl DockerCommand) {
        let name = if kind == "network" {
            self.name.clone()
        } else {
            format!("acp-sess-{}", self.session)
        };
        match inspect_owned_id(kind, &name, &self.session, docker) {
            Ok(id) if kind == "network" => self.id = id,
            Ok(id) => self.container = id,
            Err(error) => {
                tracing::error!(%error, %name, "could not reconcile uncertain Docker allocation; nothing unowned was removed");
                self.finish_cleanup(&Err(error));
            }
        }
    }

    pub async fn cleanup(self) -> anyhow::Result<()> {
        tokio::task::spawn_blocking(move || self.cleanup_blocking())
            .await
            .context("session cleanup worker failed")?
    }

    pub fn cleanup_blocking(mut self) -> anyhow::Result<()> {
        let result = self.cleanup_with(&mut Docker);
        self.cleanup_on_drop = false;
        result
    }

    fn cleanup_with(&mut self, docker: &mut impl DockerCommand) -> anyhow::Result<()> {
        let result = self.cleanup_until(docker, Instant::now() + CLEANUP_TIMEOUT);
        self.finish_cleanup(&result);
        result
    }

    fn finish_cleanup(&mut self, result: &anyhow::Result<()>) {
        if let Some(capacity) = self.capacity.take() {
            if result.is_err() {
                capacity.forget();
                tracing::error!(container = ?self.container, network = ?self.id,
                    "session capacity retained after failed Docker cleanup; operator cleanup and gateway restart required");
            }
        }
    }

    fn cleanup_until(
        &mut self,
        docker: &mut impl DockerCommand,
        deadline: Instant,
    ) -> anyhow::Result<()> {
        let mut last_error = None;
        while Instant::now() < deadline {
            if let Some(id) = &self.container {
                match docker.run(&["rm", "--force", id], deadline) {
                    Ok(_) => self.container = None,
                    Err(error) if missing_resource(&error) => self.container = None,
                    Err(error) => last_error = Some(error),
                }
            }
            if let Some(id) = &self.id {
                for peer in &self.peers {
                    // A vanished peer or already-detached endpoint is harmless;
                    // successful network removal is the final cleanup evidence.
                    let _ = docker.run(&["network", "disconnect", "--force", id, peer], deadline);
                }
                match docker.run(&["network", "rm", id], deadline) {
                    Ok(_) => self.id = None,
                    Err(error) if missing_resource(&error) => self.id = None,
                    Err(error) => last_error = Some(error),
                }
            }
            if self.container.is_none() && self.id.is_none() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        bail!(
            "session Docker cleanup exceeded {:?}; container {:?}, network {:?}: {}",
            CLEANUP_TIMEOUT,
            self.container,
            self.id,
            last_error
                .map(|error| error.to_string())
                .unwrap_or_default()
        )
    }
}
impl Drop for SessionNetwork {
    fn drop(&mut self) {
        if !self.cleanup_on_drop {
            if self.capacity.is_some() && (self.id.is_some() || self.container.is_some()) {
                self.finish_cleanup(&Err(anyhow::anyhow!("cleanup worker did not run")));
            }
            return;
        }
        if self.id.is_none() && self.container.is_none() {
            return;
        }
        // Cancellation/error fallback must not block the Tokio executor. Normal
        // session completion awaits cleanup explicitly while holding capacity.
        let mut pending = Self {
            name: self.name.clone(),
            session: self.session.clone(),
            id: self.id.take(),
            container: self.container.take(),
            peers: std::mem::take(&mut self.peers),
            cleanup_on_drop: false,
            capacity: self.capacity.take(),
            startup_deadline: self.startup_deadline,
            image_id: self.image_id.clone(),
        };
        if let Err(error) = std::thread::Builder::new()
            .name("acp-session-cleanup".into())
            .spawn(move || {
                if let Err(error) = pending.cleanup_with(&mut Docker) {
                    tracing::error!(%error, "session Docker cleanup failed");
                }
            })
        {
            tracing::error!(%error, "could not start session cleanup worker");
        }
    }
}

fn inspect_owned_id(
    kind: &str,
    name: &str,
    session: &str,
    docker: &mut impl DockerCommand,
) -> anyhow::Result<Option<String>> {
    let output = match docker.run(
        &["inspect", "--type", kind, "--format", "{{json .}}", name],
        Instant::now() + CLEANUP_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) if missing_resource(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let resource: serde_json::Value = serde_json::from_str(&output)?;
    let labels = resource.pointer(if kind == "network" {
        "/Labels"
    } else {
        "/Config/Labels"
    });
    if labels
        .and_then(|labels| labels.get(EGRESS_LABEL))
        .and_then(|v| v.as_str())
        != Some(SESSION_OWNER)
        || labels
            .and_then(|labels| labels.get(SESSION_LABEL))
            .and_then(|v| v.as_str())
            != Some(session)
    {
        bail!("resource at session name has different ownership labels; nothing was removed");
    }
    Ok(Some(docker_id(
        resource
            .get("Id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("invalid inspected Docker resource ID"))?,
    )?))
}

fn docker_id(output: &str) -> anyhow::Result<String> {
    let id = output.trim();
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("Docker returned an invalid immutable resource ID");
    }
    Ok(id.into())
}

fn missing_resource(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.contains("No such container:")
        || text.contains("No such network:")
        || (text.contains("network ") && text.contains(" not found"))
}

trait DockerCommand {
    fn run(&mut self, args: &[&str], deadline: Instant) -> anyhow::Result<String>;
}
struct Docker;
impl DockerCommand for Docker {
    fn run(&mut self, args: &[&str], deadline: Instant) -> anyhow::Result<String> {
        use std::process::{Command, Stdio};
        if Instant::now() >= deadline {
            bail!("Docker operation deadline elapsed");
        }
        let child = Command::new("docker")
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Docker is required for boxed sessions")?;
        bounded_output(child, deadline, args)
    }
}

fn bounded_output(
    mut child: std::process::Child,
    deadline: Instant,
    args: &[&str],
) -> anyhow::Result<String> {
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Docker operation timed out: {}", args.join(" "));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "Docker operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8(output.stdout).context("invalid Docker output")
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
    use std::collections::VecDeque;

    struct Fixture(VecDeque<(Vec<String>, Result<String, &'static str>)>);
    impl DockerCommand for Fixture {
        fn run(&mut self, args: &[&str], _deadline: Instant) -> anyhow::Result<String> {
            let (expected, result) = self.0.pop_front().expect("unexpected Docker command");
            assert_eq!(
                args,
                expected.iter().map(String::as_str).collect::<Vec<_>>()
            );
            result.map_err(anyhow::Error::msg)
        }
    }
    fn step(
        args: &[&str],
        output: Result<&str, &'static str>,
    ) -> (Vec<String>, Result<String, &'static str>) {
        (
            args.iter().map(|s| (*s).into()).collect(),
            output.map(str::to_string),
        )
    }
    fn owned(network: &str, container: Option<&str>, peer: &str) -> SessionNetwork {
        SessionNetwork {
            name: "a-name-that-may-now-belong-to-someone-else".into(),
            session: "test".into(),
            id: Some(network.into()),
            container: container.map(str::to_string),
            peers: vec![peer.into()],
            cleanup_on_drop: false,
            capacity: None,
            startup_deadline: Instant::now() + STARTUP_TIMEOUT,
            image_id: None,
        }
    }

    fn image_fixture() -> String {
        serde_json::json!({ "Id": format!("sha256:{}", "d".repeat(64)), "Config": { "Env": ["PATH=/usr/bin"] } }).to_string()
    }
    fn egress_fixture(id: &str, running: bool) -> serde_json::Value {
        serde_json::json!({
            "Id": id, "Image": format!("sha256:{}", "d".repeat(64)),
            "Config": { "Labels": { EGRESS_LABEL: EGRESS_OWNER }, "Entrypoint": ["node"],
                "Cmd": ["/opt/agent-connect/egress-proxy.mjs"], "Env": ["PATH=/usr/bin"] },
            "HostConfig": { "ReadonlyRootfs": true, "Privileged": false, "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges"], "Memory": 268435456,
                "NanoCpus": 1000000000, "PidsLimit": 64, "NetworkMode": "bridge",
                "RestartPolicy": { "Name": "unless-stopped" },
                "LogConfig": { "Type": "json-file", "Config": { "max-size": "10m", "max-file": "3" } } },
            "State": { "Running": running, "Restarting": false }, "Mounts": []
        })
    }

    #[test]
    fn egress_start_reuses_running_and_starts_stopped_by_owned_id() {
        let id = "a".repeat(64);
        let image = image_fixture();
        for running in [true, false] {
            let mut steps = VecDeque::from([
                step(
                    &["image", "inspect", "--format", "{{json .}}", "session:test"],
                    Ok(&image),
                ),
                step(
                    &[
                        "inspect",
                        "--type",
                        "container",
                        "--format",
                        "{{json .}}",
                        "owned-egress",
                    ],
                    Ok(&egress_fixture(&id, running).to_string()),
                ),
            ]);
            if !running {
                steps.push_back(step(&["start", &id], Ok(&id)));
            }
            steps.push_back(step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    &id,
                ],
                Ok(&egress_fixture(&id, true).to_string()),
            ));
            let mut docker = Fixture(steps);
            egress_start_with("owned-egress", "session:test", &mut docker).unwrap();
            assert!(docker.0.is_empty());
        }
    }

    #[test]
    fn egress_refuses_unowned_wrong_image_or_modified_proxy() {
        let image = SessionImage {
            id: format!("sha256:{}", "d".repeat(64)),
            env: serde_json::json!(["PATH=/usr/bin"]),
            user: serde_json::Value::Null,
        };
        for pointer in [
            "/Config/Labels/org.agent-connect.component",
            "/Image",
            "/Config/Cmd",
            "/Config/Env",
            "/HostConfig/ReadonlyRootfs",
            "/HostConfig/Privileged",
            "/HostConfig/PortBindings",
            "/HostConfig/LogConfig/Config/max-size",
            "/HostConfig/RestartPolicy/Name",
        ] {
            let mut container = egress_fixture(&"a".repeat(64), true);
            if pointer == "/HostConfig/PortBindings" {
                container["HostConfig"]["PortBindings"] =
                    serde_json::json!({"3128/tcp": [{"HostPort":"3128"}]});
            } else {
                *container.pointer_mut(pointer).unwrap() = serde_json::json!("modified");
            }
            assert!(
                validate_egress(&container, &image, true).is_err(),
                "{pointer}"
            );
        }
        assert!(validate_egress(&egress_fixture(&"a".repeat(64), false), &image, true).is_err());
    }

    #[test]
    fn teardown_removes_owned_box_before_network_and_retries_endpoint_race() {
        let network = "a".repeat(64);
        let container = "b".repeat(64);
        let peer = "c".repeat(64);
        let mut session = owned(&network, Some(&container), &peer);
        let mut docker = Fixture(VecDeque::from([
            step(&["rm", "--force", &container], Ok("")),
            step(
                &["network", "disconnect", "--force", &network, &peer],
                Ok(""),
            ),
            step(
                &["network", "rm", &network],
                Err("network has active endpoints"),
            ),
            step(
                &["network", "disconnect", "--force", &network, &peer],
                Err("No such container: peer"),
            ),
            step(&["network", "rm", &network], Ok("")),
        ]));
        session.cleanup_with(&mut docker).unwrap();
        assert!(docker.0.is_empty());
        assert!(session.id.is_none() && session.container.is_none());
    }

    #[test]
    fn already_removed_owned_resources_are_successful_teardown() {
        let mut session = owned("network-id", Some("box-id"), "peer-id");
        let mut docker = Fixture(VecDeque::from([
            step(
                &["rm", "--force", "box-id"],
                Err("No such container: box-id"),
            ),
            step(
                &["network", "disconnect", "--force", "network-id", "peer-id"],
                Err("No such network: network-id"),
            ),
            step(
                &["network", "rm", "network-id"],
                Err("network network-id not found"),
            ),
        ]));
        session.cleanup_with(&mut docker).unwrap();
        assert!(docker.0.is_empty());
    }

    #[test]
    fn peer_connect_failure_rolls_back_only_new_network_and_captured_peer() {
        let network = "a".repeat(64);
        let peer = "b".repeat(64);
        let mut docker = Fixture(VecDeque::from([
            step(
                &[
                    "network",
                    "create",
                    "--internal",
                    "--label",
                    "org.agent-connect.component=acp-session",
                    "--label",
                    "org.agent-connect.session=test",
                    "acp-sess-net-test",
                ],
                Ok(&network),
            ),
            step(
                &["image", "inspect", "--format", "{{json .}}", "session:test"],
                Ok(&image_fixture()),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    "egress-name",
                ],
                Ok(&egress_fixture(&peer, true).to_string()),
            ),
            step(
                &["network", "connect", "--alias", "egress", &network, &peer],
                Err("injected connect failure"),
            ),
            step(
                &["network", "disconnect", "--force", &network, &peer],
                Ok(""),
            ),
            step(&["network", "rm", &network], Ok("")),
        ]));
        let error = SessionNetwork::create_with(
            "test",
            "egress-name",
            None,
            "session:test",
            None,
            &mut docker,
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("injected connect failure"));
        assert!(docker.0.is_empty());
    }

    #[test]
    fn session_refuses_unowned_egress_before_connect_and_rolls_back_network() {
        let network = "a".repeat(64);
        let mut unowned = egress_fixture(&"b".repeat(64), true);
        unowned["Config"]["Labels"][EGRESS_LABEL] = serde_json::json!("unrelated");
        let mut docker = Fixture(VecDeque::from([
            step(
                &[
                    "network",
                    "create",
                    "--internal",
                    "--label",
                    "org.agent-connect.component=acp-session",
                    "--label",
                    "org.agent-connect.session=test",
                    "acp-sess-net-test",
                ],
                Ok(&network),
            ),
            step(
                &["image", "inspect", "--format", "{{json .}}", "session:test"],
                Ok(&image_fixture()),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    "egress-name",
                ],
                Ok(&unowned.to_string()),
            ),
            step(&["network", "rm", &network], Ok("")),
        ]));
        let error = SessionNetwork::create_with(
            "test",
            "egress-name",
            None,
            "session:test",
            None,
            &mut docker,
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("not labelled"));
        assert!(docker.0.is_empty());
    }

    #[test]
    fn session_rechecks_running_owned_egress_by_captured_id_after_connect() {
        let network = "a".repeat(64);
        let peer = "b".repeat(64);
        let mut docker = Fixture(VecDeque::from([
            step(
                &[
                    "network",
                    "create",
                    "--internal",
                    "--label",
                    "org.agent-connect.component=acp-session",
                    "--label",
                    "org.agent-connect.session=test",
                    "acp-sess-net-test",
                ],
                Ok(&network),
            ),
            step(
                &["image", "inspect", "--format", "{{json .}}", "session:test"],
                Ok(&image_fixture()),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    "egress-name",
                ],
                Ok(&egress_fixture(&peer, true).to_string()),
            ),
            step(
                &["network", "connect", "--alias", "egress", &network, &peer],
                Ok(""),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    &peer,
                ],
                Ok(&egress_fixture(&peer, false).to_string()),
            ),
            step(
                &["network", "disconnect", "--force", &network, &peer],
                Ok(""),
            ),
            step(&["network", "rm", &network], Ok("")),
        ]));
        let error = SessionNetwork::create_with(
            "test",
            "egress-name",
            None,
            "session:test",
            None,
            &mut docker,
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("stopped"));
        assert!(docker.0.is_empty());
    }

    #[test]
    fn preflight_is_read_only_and_rejects_absent_image_or_stopped_proxy() {
        let image = image_fixture();
        let id = "a".repeat(64);
        let mut absent = Fixture(VecDeque::from([step(
            &["image", "inspect", "--format", "{{json .}}", "session:test"],
            Err("Docker daemon is unavailable"),
        )]));
        assert!(
            preflight_with("session:test", "egress-name", &mut absent)
                .unwrap_err()
                .to_string()
                .contains("image is unavailable")
        );
        assert!(absent.0.is_empty());
        let mut stopped = Fixture(VecDeque::from([
            step(
                &["image", "inspect", "--format", "{{json .}}", "session:test"],
                Ok(&image),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    "egress-name",
                ],
                Ok(&egress_fixture(&id, false).to_string()),
            ),
        ]));
        assert!(
            preflight_with("session:test", "egress-name", &mut stopped)
                .unwrap_err()
                .to_string()
                .contains("stopped")
        );
        assert!(stopped.0.is_empty());
    }

    #[test]
    fn box_allocation_uses_network_id_and_attaches_by_container_id() {
        let network = "a".repeat(64);
        let container = "b".repeat(64);
        let mut session = owned(&network, None, "peer-id");
        let args = box_args(
            Harness::Codex,
            "test",
            "agent-full-access",
            None,
            None,
            "session:test",
            "reused-network-name",
            false,
        );
        let mut expected = args[1..].to_vec();
        expected[0] = "create".into();
        let pos = expected.iter().position(|arg| arg == "--network").unwrap();
        expected[pos + 1] = network;
        let mut docker = Fixture(VecDeque::from([(expected, Ok(container.clone()))]));
        let command = session.create_box_with(args, &mut docker).unwrap();
        assert_eq!(
            command,
            vec!["docker", "start", "--attach", "--interactive", &container]
        );
        assert_eq!(session.container.as_deref(), Some(container.as_str()));
        assert!(docker.0.is_empty());
    }

    #[test]
    fn uncertain_container_creation_recovers_owned_id_before_rollback() {
        let network = "a".repeat(64);
        let container = "b".repeat(64);
        let mut session = owned(&network, None, "peer-id");
        let args = box_args(
            Harness::Codex,
            "test",
            "agent-full-access",
            None,
            None,
            "session:test",
            "network-name",
            false,
        );
        let mut create = args[1..].to_vec();
        create[0] = "create".into();
        let pos = create.iter().position(|arg| arg == "--network").unwrap();
        create[pos + 1] = network.clone();
        let inspected = serde_json::json!({"Id": container, "Config": {"Labels": {
            EGRESS_LABEL: SESSION_OWNER, SESSION_LABEL: "test"
        }}})
        .to_string();
        let mut docker = Fixture(VecDeque::from([
            (create, Err("injected lost create response")),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    "acp-sess-test",
                ],
                Ok(&inspected),
            ),
            step(&["rm", "--force", &container], Ok("")),
            step(
                &["network", "disconnect", "--force", &network, "peer-id"],
                Ok(""),
            ),
            step(&["network", "rm", &network], Ok("")),
        ]));
        assert!(session.create_box_with(args, &mut docker).is_err());
        assert_eq!(session.container.as_deref(), Some(container.as_str()));
        session.cleanup_with(&mut docker).unwrap();
        assert!(docker.0.is_empty());
    }

    #[test]
    fn uncertain_allocation_never_adopts_a_replacement_with_foreign_labels() {
        let inspected = serde_json::json!({"Id": "b".repeat(64), "Config": {"Labels": {
            EGRESS_LABEL: SESSION_OWNER, SESSION_LABEL: "someone-else"
        }}})
        .to_string();
        let mut docker = Fixture(VecDeque::from([step(
            &[
                "inspect",
                "--type",
                "container",
                "--format",
                "{{json .}}",
                "acp-sess-test",
            ],
            Ok(&inspected),
        )]));
        assert!(inspect_owned_id("container", "acp-sess-test", "test", &mut docker).is_err());
        assert!(docker.0.is_empty());
    }

    #[test]
    fn cleanup_deadline_reports_remaining_ids_without_removing_by_name() {
        let mut session = owned("owned-network", Some("owned-box"), "peer-id");
        let mut docker = Fixture(VecDeque::new());
        let error = session
            .cleanup_until(&mut docker, Instant::now())
            .unwrap_err();
        assert!(error.to_string().contains("owned-network"));
        assert!(error.to_string().contains("owned-box"));
    }

    #[test]
    fn hung_docker_client_is_killed_within_deadline() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        let error =
            bounded_output(child, started + Duration::from_millis(40), &["fixture"]).unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn capacity_releases_after_success_and_stays_reserved_after_cleanup_failure() {
        let capacity = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let mut session = owned("network-id", None, "peer-id");
        session.capacity = Some(capacity.clone().try_acquire_owned().unwrap());
        let mut docker = Fixture(VecDeque::from([
            step(
                &["network", "disconnect", "--force", "network-id", "peer-id"],
                Ok(""),
            ),
            step(&["network", "rm", "network-id"], Ok("")),
        ]));
        session.cleanup_with(&mut docker).unwrap();
        assert_eq!(capacity.available_permits(), 1);
        let mut session = owned("network-id", Some("box-id"), "peer-id");
        session.capacity = Some(capacity.clone().try_acquire_owned().unwrap());
        let result = session.cleanup_until(&mut Fixture(VecDeque::new()), Instant::now());
        session.finish_cleanup(&result);
        drop(session);
        assert_eq!(capacity.available_permits(), 0);
    }

    #[tokio::test]
    async fn successful_startup_rollback_releases_capacity() {
        let network = "a".repeat(64);
        let mut docker = Fixture(VecDeque::from([
            step(
                &[
                    "network",
                    "create",
                    "--internal",
                    "--label",
                    "org.agent-connect.component=acp-session",
                    "--label",
                    "org.agent-connect.session=test",
                    "acp-sess-net-test",
                ],
                Ok(&network),
            ),
            step(
                &["image", "inspect", "--format", "{{json .}}", "session:test"],
                Ok(&image_fixture()),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{json .}}",
                    "egress-name",
                ],
                Err("missing test egress"),
            ),
            step(&["network", "rm", &network], Ok("")),
        ]));
        let capacity = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let permit = capacity.clone().try_acquire_owned().unwrap();
        assert!(
            SessionNetwork::create_with(
                "test",
                "egress-name",
                None,
                "session:test",
                Some(permit),
                &mut docker
            )
            .is_err()
        );
        assert_eq!(capacity.available_permits(), 1);
        assert!(docker.0.is_empty());
    }

    #[tokio::test]
    async fn failed_startup_rollback_retains_capacity_after_deadline() {
        struct FailedRollback;
        impl DockerCommand for FailedRollback {
            fn run(&mut self, args: &[&str], deadline: Instant) -> anyhow::Result<String> {
                match args {
                    ["network", "create", ..] => Ok("a".repeat(64)),
                    ["image", "inspect", ..] => Ok(image_fixture()),
                    ["inspect", ..] => anyhow::bail!("injected startup failure"),
                    ["network", "rm", id] => {
                        assert_eq!(*id, "a".repeat(64));
                        // One wedged daemon operation consumes the entire bounded
                        // rollback deadline. No real Docker daemon is involved.
                        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
                        anyhow::bail!("injected network removal failure")
                    }
                    _ => panic!("unexpected rollback command: {args:?}"),
                }
            }
        }
        let capacity = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let permit = capacity.clone().try_acquire_owned().unwrap();
        let error = SessionNetwork::create_with(
            "test",
            "egress-name",
            None,
            "session:test",
            Some(permit),
            &mut FailedRollback,
        )
        .err()
        .unwrap();
        assert!(format!("{error:#}").contains("injected startup failure"));
        assert_eq!(capacity.available_permits(), 0);
    }

    #[test]
    fn egress_uses_same_image_without_host_port_or_credentials() {
        let args = egress_start_args("owned-egress", "session:test");
        assert!(args.contains(&"--read-only".into()));
        assert!(args.contains(&"--restart=unless-stopped".into()));
        assert!(args.contains(&"max-size=10m".into()));
        assert!(args.contains(&"max-file=3".into()));
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
