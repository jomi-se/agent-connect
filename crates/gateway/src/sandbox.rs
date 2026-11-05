//! Per-session containers. The container, not harness prompts, bounds native actions.
use crate::{Harness, credentials::HarnessHome, engine::Engine};
use anyhow::{Context, bail};
use std::time::{Duration, Instant};

const SESSION_LABEL: &str = "org.agent-connect.session";
const SESSION_OWNER: &str = "acp-session";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(8);

const EGRESS_LABEL: &str = "org.agent-connect.component";
const EGRESS_OWNER: &str = "acp-egress";
const KEEPALIVE_OWNER: &str = "acp-egress-keepalive";

/// The container that keeps rootless Podman's shared network up for the
/// egress. Podman 4 tears that network down when a container leaves a network
/// and no *other* running container uses it, so disconnecting the egress from
/// the last session's network would cut the egress itself off the internet.
/// A workaround for Podman < 5 only (Podman 5 counts the network's users); it
/// can go once Podman 5 is the minimum.
pub fn keepalive_name(egress: &str) -> String {
    format!("{egress}-keepalive")
}
fn keepalive_args(name: &str, image: &str) -> Vec<String> {
    [
        "run",
        "--pull=never",
        "--detach",
        "--name",
        name,
        "--label",
        &format!("{EGRESS_LABEL}={KEEPALIVE_OWNER}"),
        "--network",
        "podman",
        "--restart=always",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory=16m",
        "--pids-limit=4",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Starts the egress's keepalive on Podman, creating it from `image` or
/// replacing an owned one built from another image. A container of that
/// name without the keepalive label is never touched.
fn ensure_keepalive(
    program: crate::engine::Program,
    egress: &str,
    image: &BoxImage,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> anyhow::Result<()> {
    if program != crate::engine::Program::Podman {
        return Ok(());
    }
    let name = keepalive_name(egress);
    if let Some(container) = inspect_container(&name, docker, deadline)? {
        if container
            .pointer("/Config/Labels")
            .and_then(|v| v.get(EGRESS_LABEL))
            .and_then(|v| v.as_str())
            != Some(KEEPALIVE_OWNER)
        {
            bail!("container {name} is not an Agent Connect egress keepalive; nothing was changed");
        }
        let id = container
            .get("Id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing inspected keepalive ID"))?;
        if container.get("Image").and_then(|v| v.as_str()) == Some(image.id.as_str()) {
            if container
                .pointer("/State/Running")
                .and_then(|v| v.as_bool())
                != Some(true)
            {
                docker
                    .run(&["start", id], deadline)
                    .context("could not start the egress keepalive")?;
            }
            return Ok(());
        }
        // Removing it is safe while the egress runs: the egress still counts.
        docker
            .run(&force_remove(program, id), deadline)
            .context("could not replace the egress keepalive")?;
    }
    let args = keepalive_args(&name, &image.id);
    docker
        .run(
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            deadline,
        )
        .context("could not create the egress keepalive")?;
    Ok(())
}

pub fn egress_start_args(name: &str, image: &str) -> Vec<String> {
    egress_args(crate::engine::selected(), name, image)
}
fn egress_args(program: crate::engine::Program, name: &str, image: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "run",
        "--pull=never",
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
    .collect();
    if program == crate::engine::Program::Podman {
        // A rootless container started without a network gets user-mode
        // networking (slirp4netns, pasta in Podman 5), which cannot join the
        // session networks later; the default bridge can.
        args.splice(1..1, ["--network".to_string(), "podman".to_string()]);
    }
    args
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
    ensure_keepalive(crate::engine::selected(), name, &image, docker, deadline)?;
    match inspect_container(name, docker, deadline)? {
        Some(container) if serves_another_box(&container, &image, docker, deadline) => {
            // The box was rebuilt (or a refresh stopped halfway): this egress
            // is ours and sound, only for the previous box. Replace it by its
            // inspected ID.
            let id = EgressFacts::read(&container, crate::engine::selected())?.id;
            docker
                .run(&force_remove(crate::engine::selected(), &id), deadline)
                .context("could not replace the egress proxy of the previous box")?;
            let args = egress_start_args(name, &image.id);
            docker.run(&args.iter().map(String::as_str).collect::<Vec<_>>(), deadline)
                .context("could not create egress proxy; check the container engine and any conflicting container name")?;
        }
        Some(container) => {
            let id = validate_egress(&container, &image, false)?;
            if container
                .pointer("/State/Running")
                .and_then(|v| v.as_bool())
                != Some(true)
            {
                docker.run(&["start", &id], deadline).context(
                    "could not start owned egress proxy; inspect the container engine's state before retrying",
                )?;
            }
            // Inspect the captured ID, never the possibly reused name.
            let running = inspect_container(&id, docker, deadline)?.ok_or_else(|| {
                anyhow::anyhow!(
                    "owned egress proxy disappeared while starting; restart the gateway"
                )
            })?;
            validate_egress(&running, &image, true)?;
        }
        None => {
            let args = egress_start_args(name, &image.id);
            docker.run(&args.iter().map(String::as_str).collect::<Vec<_>>(), deadline)
                .context("could not create egress proxy; check the container engine and any conflicting container name")?;
        }
    }
    Ok(())
}

/// Whether `container` is an owned egress that differs from what `image`
/// needs only in being built from another image: judged against its own
/// image, it passes every other check.
fn serves_another_box(
    container: &serde_json::Value,
    image: &BoxImage,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> bool {
    let owned = container
        .pointer("/Config/Labels")
        .and_then(|v| v.get(EGRESS_LABEL))
        .and_then(|v| v.as_str())
        == Some(EGRESS_OWNER);
    let Ok(facts) = EgressFacts::read(container, crate::engine::selected()) else {
        return false;
    };
    if !owned || facts.image == image.id {
        return false;
    }
    inspect_image(&facts.image, docker, deadline)
        .is_ok_and(|own| judge_egress(&facts, &own, false).is_ok())
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
    if crate::engine::selected() == crate::engine::Program::Podman {
        checked_keepalive(egress, docker, deadline)?;
    }
    Ok(())
}
fn checked_keepalive(
    egress: &str,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> anyhow::Result<()> {
    let keepalive = inspect_container(&keepalive_name(egress), docker, deadline)?;
    let owned_and_running = keepalive.as_ref().is_some_and(|c| {
        c.pointer("/Config/Labels")
            .and_then(|v| v.get(EGRESS_LABEL))
            .and_then(|v| v.as_str())
            == Some(KEEPALIVE_OWNER)
            && c.pointer("/State/Running").and_then(|v| v.as_bool()) == Some(true)
    });
    if !owned_and_running {
        bail!(
            "the egress keepalive is absent or stopped, so a session ending could cut the egress off; restart the gateway"
        );
    }
    Ok(())
}

struct BoxImage {
    id: String,
    env: serde_json::Value,
    user: serde_json::Value,
}
fn inspect_image(
    image: &str,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> anyhow::Result<BoxImage> {
    let output = docker.run(&["image", "inspect", "--format", "{{json .}}", image], deadline)
        .context("selected box is unavailable; the container engine must be running and the selected image installed before serve")?;
    let value: serde_json::Value =
        serde_json::from_str(&output).context("invalid image inspection")?;
    let id = value
        .get("Id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing inspected image ID"))?;
    docker_id(id.strip_prefix("sha256:").unwrap_or(id))?;
    Ok(BoxImage {
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
            serde_json::from_str(&output).context("invalid egress inspection")?,
        )),
        Err(error) if missing_resource(&error) => Ok(None),
        Err(error) => Err(error)
            .context("cannot inspect egress proxy; check that the container engine is running and accessible"),
    }
}
fn checked_egress(
    name: &str,
    image: &BoxImage,
    docker: &mut impl DockerCommand,
    deadline: Instant,
) -> anyhow::Result<String> {
    let container = inspect_container(name, docker, deadline)?
        .ok_or_else(|| anyhow::anyhow!("egress proxy is absent; restart the gateway"))?;
    validate_egress(&container, image, true)
}
fn validate_egress(
    container: &serde_json::Value,
    image: &BoxImage,
    running: bool,
) -> anyhow::Result<String> {
    let owner = container
        .pointer("/Config/Labels")
        .and_then(|v| v.get(EGRESS_LABEL))
        .and_then(|v| v.as_str());
    if owner != Some(EGRESS_OWNER) {
        bail!("container is not labelled as an Agent Connect egress proxy; nothing was changed");
    }
    let facts = EgressFacts::read(container, crate::engine::selected())?;
    judge_egress(&facts, image, running)?;
    Ok(facts.id)
}

/// What the egress check judges, read from one engine's inspection. Each fact
/// has an extractor per engine and a missing field is an error, so a field
/// only one engine reports is never judged by the other engine's meaning.
#[derive(Debug)]
struct EgressFacts {
    id: String,
    image: String,
    entrypoint: Vec<String>,
    cmd: Vec<String>,
    /// The container's environment minus what the engine itself injects.
    env: Vec<String>,
    /// Engine-injected variables, judged against the image separately.
    injected_home: Option<String>,
    user: serde_json::Value,
    read_only: bool,
    privileged: bool,
    memory: i64,
    nano_cpus: i64,
    pids_limit: i64,
    all_caps_dropped: bool,
    security_opt: Vec<String>,
    no_devices: bool,
    host_namespace: bool,
    no_mounts: bool,
    no_published_ports: bool,
    restart: String,
    log_bounded: bool,
    /// Podman's record of how the container was made, after the program name,
    /// with the container's name; Docker keeps no such record.
    created_with: Option<(String, Vec<String>)>,
    running: bool,
    restarting: bool,
    unhealthy: bool,
}

impl EgressFacts {
    fn read(
        container: &serde_json::Value,
        program: crate::engine::Program,
    ) -> anyhow::Result<Self> {
        use crate::engine::Program;
        use serde_json::Value;
        let field = |pointer: &str| {
            container
                .pointer(pointer)
                .ok_or_else(|| anyhow::anyhow!("egress inspection lacks {pointer}"))
        };
        let string = |pointer: &str| {
            field(pointer)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("egress inspection {pointer} is not a string"))
        };
        let strings = |value: &Value| -> anyhow::Result<Vec<String>> {
            match value {
                Value::Null => Ok(Vec::new()),
                Value::Array(items) => items
                    .iter()
                    .map(|item| {
                        item.as_str().map(str::to_owned).ok_or_else(|| {
                            anyhow::anyhow!("egress inspection list holds a non-string")
                        })
                    })
                    .collect(),
                _ => bail!("egress inspection list has an unexpected shape"),
            }
        };
        let number = |pointer: &str| {
            field(pointer)?
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("egress inspection {pointer} is not a number"))
        };
        let flag = |pointer: &str| {
            field(pointer)?
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("egress inspection {pointer} is not a boolean"))
        };
        // Present but null, empty list or empty object.
        let empty = |pointer: &str| {
            field(pointer).map(|v| {
                v.is_null()
                    || v.as_array().is_some_and(Vec::is_empty)
                    || v.as_object().is_some_and(serde_json::Map::is_empty)
            })
        };
        let host = |pointer: &str| string(pointer).map(|mode| mode == "host");
        let mut env = strings(field("/Config/Env")?)?;
        let (entrypoint, all_caps_dropped, injected_home, log_bounded, no_devices, created_with) =
            match program {
                Program::Docker => (
                    strings(field("/Config/Entrypoint")?)?,
                    field("/HostConfig/CapDrop")? == &serde_json::json!(["ALL"])
                        && empty("/HostConfig/CapAdd")?,
                    None,
                    string("/HostConfig/LogConfig/Type")? == "json-file"
                        && field("/HostConfig/LogConfig/Config/max-size")? == "10m"
                        && field("/HostConfig/LogConfig/Config/max-file")? == "3",
                    empty("/HostConfig/Devices")? && empty("/HostConfig/DeviceRequests")?,
                    None,
                ),
                Program::Podman => {
                    // Podman 4 reports a single-word entrypoint as a string; a
                    // string with spaces would hide its argument boundaries.
                    let entrypoint = match field("/Config/Entrypoint")? {
                        Value::String(word)
                            if !word.is_empty() && !word.contains(char::is_whitespace) =>
                        {
                            vec![word.clone()]
                        }
                        Value::String(_) => bail!("egress entrypoint is ambiguous"),
                        other => strings(other)?,
                    };
                    // HostConfig.CapAdd stays empty even when a capability is added
                    // back; EffectiveCaps is what the container really holds, and it
                    // is null only when every capability was dropped.
                    let all_caps_dropped = empty("/EffectiveCaps")?;
                    // Podman adds these three; anything else must match the image.
                    let mut home = None;
                    let mut container_marker = false;
                    env.retain(|entry| match entry.split_once('=') {
                        Some(("container", "podman")) => {
                            container_marker = true;
                            false
                        }
                        Some(("HOME", value)) => {
                            home = Some(value.to_owned());
                            false
                        }
                        Some(("HOSTNAME", _)) => false,
                        _ => true,
                    });
                    anyhow::ensure!(
                        container_marker,
                        "egress inspection lacks Podman's container marker"
                    );
                    (
                        entrypoint,
                        all_caps_dropped,
                        home,
                        string("/HostConfig/LogConfig/Type")? == "json-file"
                            && string("/HostConfig/LogConfig/Size")? == "10MB",
                        // Podman has no device requests; GPUs arrive as devices. Podman 4
                        // leaves Devices empty even with one attached, which is why the
                        // creation record below is required.
                        empty("/HostConfig/Devices")?,
                        Some((
                            string("/Name")?,
                            strings(field("/Config/CreateCommand")?)?
                                .into_iter()
                                .skip(1)
                                .collect(),
                        )),
                    )
                }
            };
        env.sort();
        let health = container
            .pointer("/State/Health/Status")
            .and_then(Value::as_str);
        Ok(Self {
            id: docker_id(&string("/Id")?)?,
            image: string("/Image")?,
            entrypoint,
            cmd: strings(field("/Config/Cmd")?)?,
            env,
            injected_home,
            user: field("/Config/User")?.clone(),
            read_only: flag("/HostConfig/ReadonlyRootfs")?,
            privileged: flag("/HostConfig/Privileged")?,
            memory: number("/HostConfig/Memory")?,
            nano_cpus: number("/HostConfig/NanoCpus")?,
            pids_limit: number("/HostConfig/PidsLimit")?,
            all_caps_dropped,
            security_opt: strings(field("/HostConfig/SecurityOpt")?)?,
            no_devices,
            // UsernsMode and UTSMode were considered: a host user namespace makes
            // container root the owner on a rootless engine, which gives the egress
            // nothing it lacks, and the hostname is not a boundary.
            host_namespace: host("/HostConfig/PidMode")?
                || host("/HostConfig/IpcMode")?
                || host("/HostConfig/NetworkMode")?,
            // `--tmpfs` lands in Tmpfs on both engines, Podman's tmpfs mounts too.
            // Docker's API declares Tmpfs omitempty (the only such field here),
            // so there an absent key is its way of saying none.
            no_mounts: empty("/HostConfig/Binds")?
                && empty("/Mounts")?
                && match (program, container.pointer("/HostConfig/Tmpfs")) {
                    (Program::Docker, None) => true,
                    _ => empty("/HostConfig/Tmpfs")?,
                },
            no_published_ports: empty("/HostConfig/PortBindings")?,
            restart: string("/HostConfig/RestartPolicy/Name")?,
            log_bounded,
            created_with,
            running: flag("/State/Running")?,
            restarting: flag("/State/Restarting")?,
            unhealthy: health == Some("unhealthy"),
        })
    }
}

fn judge_egress(facts: &EgressFacts, image: &BoxImage, running: bool) -> anyhow::Result<()> {
    let mut image_env: Vec<String> = image
        .env
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    image_env.sort();
    // Podman's injected HOME must be the image user's own home. Compared by
    // segment: release checks refuse any home-directory literal in the binary.
    let segments = |home: &str| home.split('/').map(str::to_owned).collect::<Vec<_>>();
    let home_ok = match (&facts.injected_home, image.user.as_str()) {
        (None, _) => true,
        (Some(home), Some(user)) if !user.is_empty() && user != "root" => {
            segments(home) == ["", "home", user]
        }
        (Some(home), _) => segments(home) == ["", "root"],
    };
    let trusted = facts.image == image.id
        && facts.entrypoint == ["node"]
        && facts.cmd == ["/opt/agent-connect/egress-proxy.mjs"]
        && facts.env == image_env
        && home_ok
        && facts.user == image.user
        && facts.read_only
        && !facts.privileged
        && facts.memory == 256 * 1024 * 1024
        && facts.nano_cpus == 1_000_000_000
        && facts.pids_limit == 64
        && facts.all_caps_dropped
        && facts.security_opt == ["no-new-privileges"]
        && facts.no_devices
        && !facts.host_namespace
        && facts.no_mounts
        && facts.no_published_ports
        && facts.restart == "unless-stopped"
        && facts.log_bounded;
    // Podman's creation record must be exactly what this gateway runs. It is an
    // attestation the creating client wrote, not tamper-proof, but it catches
    // what Podman's inspection leaves out (devices) and stale or hand-made
    // containers. Ground truth for devices would be `linux.devices` in the
    // runtime config at the inspected OCIConfigPath.
    let recorded = facts.created_with.as_ref().is_none_or(|(name, args)| {
        *args == egress_args(crate::engine::Program::Podman, name, &image.id)
    });
    if trusted && !recorded {
        bail!(
            "owned egress proxy was not created by this gateway version; run agent-connect setup --upgrade to recreate it"
        );
    }
    if !trusted {
        bail!(
            "owned egress proxy does not match the selected image and restricted proxy configuration; restart the gateway to recreate it"
        );
    }
    if running && (!facts.running || facts.restarting || facts.unhealthy) {
        bail!(
            "owned egress proxy is stopped, restarting or unhealthy; restart the gateway and inspect its bounded container logs"
        );
    }
    Ok(())
}

pub fn egress_stop(name: &str) -> anyhow::Result<()> {
    crate::config::validate_container_name(name)?;
    let output = std::process::Command::new(crate::engine::program())
        .args(["inspect", "--type", "container", name])
        .output()
        .with_context(|| {
            format!(
                "{} is required to stop the egress proxy",
                crate::engine::program()
            )
        })?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).to_lowercase();
        // Already gone, as after an outage; its keepalive still goes.
        if error.contains("no such container") {
            return remove_keepalive(name);
        }
        bail!("cannot inspect egress container; nothing was removed");
    }
    let containers: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).context("invalid container inspection")?;
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
    docker(&force_remove(crate::engine::selected(), id))?;
    remove_keepalive(name)
}

/// Removes the egress's keepalive if there is one and it is ours.
fn remove_keepalive(egress: &str) -> anyhow::Result<()> {
    let program = crate::engine::selected();
    if program != crate::engine::Program::Podman {
        return Ok(());
    }
    let output = std::process::Command::new(crate::engine::program())
        .args(["inspect", "--type", "container", &keepalive_name(egress)])
        .output()
        .context("Podman is required to remove the egress keepalive")?;
    if !output.status.success() {
        return Ok(());
    }
    let containers: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).context("invalid container inspection")?;
    let Some(container) = containers.first().filter(|c| {
        c.pointer("/Config/Labels")
            .and_then(|v| v.get(EGRESS_LABEL))
            .and_then(|v| v.as_str())
            == Some(KEEPALIVE_OWNER)
    }) else {
        return Ok(());
    };
    let id = container
        .get("Id")
        .and_then(|v| v.as_str())
        .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow::anyhow!("invalid inspected keepalive ID; nothing was removed"))?;
    docker(&force_remove(program, id))
}

pub fn box_args(
    harness: Harness,
    session: &str,
    mode: &str,
    home: Option<&HarnessHome>,
    program: crate::engine::Program,
    engine: Engine,
    image: &str,
    network: &str,
    mock: bool,
) -> Vec<String> {
    use crate::credentials::{BOX_GID, BOX_UID};
    let (uid, gid) = home
        .map(|h| h.box_user(engine))
        .unwrap_or((BOX_UID, BOX_GID));
    let mut args: Vec<String> = [
        match program {
            crate::engine::Program::Docker => "docker",
            crate::engine::Program::Podman => "podman",
        },
        "run",
        "--pull=never",
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
        &format!("/work:rw,exec,size=512m,{}", program.tmpfs_owner(uid, gid)),
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
        args.extend(home.docker_args(engine));
    } else {
        args.extend([
            "--tmpfs".into(),
            format!(
                "/home/node:rw,exec,size=512m,{}",
                program.tmpfs_owner(BOX_UID, BOX_GID)
            ),
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
    if home.is_some() && engine == Engine::Rootless {
        // Container root is the unprivileged invoking user here, with every
        // capability dropped. Claude Code refuses to skip permissions as root
        // unless told it is sandboxed. Never set on a rootful engine, where
        // container root would be host root.
        args.extend(["-e".into(), "IS_SANDBOX=1".into()]);
    }
    if mock {
        // Synthetic local authentication, never a provider credential or API key.
        for (key, value) in [
            // The deterministic model cannot discover deferred Claude tools.
            ("ENABLE_TOOL_SEARCH", "false"),
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
    /// `--add-host` entries naming the peers for the box, on engines whose
    /// session networks carry no DNS (see `network_create_args`).
    hosts: Vec<String>,
}

/// The session network's creation arguments. On Podman it carries no DNS
/// server: attaching a network with one puts its aardvark-dns first in the
/// egress's resolv.conf, and aardvark (1.11 and later) answers NXDOMAIN for
/// outside names on an internal network, so the egress could resolve nothing
/// while any session was open. The box then reaches its peers through
/// `--add-host` entries, and has no resolver of its own on this network.
/// Docker's embedded DNS resolves outside names for the egress through its
/// other network, so Docker keeps the aliases.
fn network_create_args(program: crate::engine::Program, session: &str, name: &str) -> Vec<String> {
    let mut args: Vec<String> = ["network", "create", "--internal"].map(String::from).into();
    if program == crate::engine::Program::Podman {
        args.push("--disable-dns".into());
    }
    args.extend([
        "--label".into(),
        format!("{EGRESS_LABEL}={SESSION_OWNER}"),
        "--label".into(),
        format!("{SESSION_LABEL}={session}"),
        name.into(),
    ]);
    args
}

impl SessionNetwork {
    pub fn create(
        session: &str,
        egress: &str,
        mock: Option<&str>,
        image: &str,
        capacity: tokio::sync::OwnedSemaphorePermit,
    ) -> anyhow::Result<Self> {
        Self::create_with(
            session,
            egress,
            mock,
            image,
            Some(capacity),
            crate::engine::selected(),
            &mut Docker,
        )
    }

    fn create_with(
        session: &str,
        egress: &str,
        mock: Option<&str>,
        image: &str,
        capacity: Option<tokio::sync::OwnedSemaphorePermit>,
        program: crate::engine::Program,
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
            hosts: Vec::new(),
        };
        let result = (|| {
            let create = network_create_args(program, session, &network.name);
            match docker
                .run(
                    &create.iter().map(String::as_str).collect::<Vec<_>>(),
                    deadline,
                )
                .and_then(|output| match program {
                    crate::engine::Program::Docker => docker_id(&output),
                    // Podman prints the name; read the ID back by name and owner labels.
                    crate::engine::Program::Podman => {
                        inspect_owned_id("network", &network.name, session, docker)?
                            .ok_or_else(|| anyhow::anyhow!("created network is missing"))
                    }
                }) {
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
                if program == crate::engine::Program::Podman {
                    let address = docker.run(
                        &[
                            "inspect",
                            "--type",
                            "container",
                            "--format",
                            &format!(
                                "{{{{(index .NetworkSettings.Networks {:?}).IPAddress}}}}",
                                network.name
                            ),
                            &id,
                        ],
                        deadline,
                    )?;
                    let address: std::net::IpAddr = address.trim().parse().with_context(|| {
                        format!("{alias} has no address on the session network")
                    })?;
                    network.hosts.push(format!("{alias}:{address}"));
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
        // How the box will reach its peers, so a box that cannot reach the
        // egress can be told apart from an egress that failed on its behalf.
        eprintln!(
            "[gateway] session {session} network {}: {}",
            network.name,
            if network.hosts.is_empty() {
                "peers by DNS alias".to_string()
            } else {
                format!("peers by --add-host {}", network.hosts.join(", "))
            }
        );
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
        let image_arg = args.len() - 3;
        args.splice(
            image_arg..image_arg,
            self.hosts
                .iter()
                .flat_map(|host| ["--add-host".to_string(), host.clone()]),
        );
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
            crate::engine::program().into(),
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
                tracing::error!(%error, %name, "could not reconcile uncertain container allocation; nothing unowned was removed");
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
                    "session capacity retained after failed container cleanup; operator cleanup and gateway restart required");
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
                match docker.run(&force_remove(crate::engine::selected(), id), deadline) {
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
            "session container cleanup exceeded {:?}; container {:?}, network {:?}: {}",
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
            hosts: std::mem::take(&mut self.hosts),
        };
        if let Err(error) = std::thread::Builder::new()
            .name("acp-session-cleanup".into())
            .spawn(move || {
                if let Err(error) = pending.cleanup_with(&mut Docker) {
                    tracing::error!(%error, "session container cleanup failed");
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
    // Both engines answer this template alike; their full JSON differs.
    let format = if kind == "network" {
        r#"{"id":{{json .ID}},"labels":{{json .Labels}}}"#
    } else {
        r#"{"id":{{json .ID}},"labels":{{json .Config.Labels}}}"#
    };
    let output = match docker.run(
        &["inspect", "--type", kind, "--format", format, name],
        Instant::now() + CLEANUP_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) if missing_resource(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let resource: serde_json::Value = serde_json::from_str(&output)?;
    let labels = resource.get("labels");
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
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("invalid inspected resource ID"))?,
    )?))
}

/// Docker's forced removal kills at once; Podman's first waits out the stop
/// timeout (10 s), longer than session cleanup's deadline, and an abandoned
/// removal leaves the box stopping. `--time 0` gives Docker's meaning.
fn force_remove(program: crate::engine::Program, id: &str) -> Vec<&str> {
    match program {
        crate::engine::Program::Docker => vec!["rm", "--force", id],
        crate::engine::Program::Podman => vec!["rm", "--force", "--time", "0", id],
    }
}

fn docker_id(output: &str) -> anyhow::Result<String> {
    let id = output.trim();
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("the container engine returned an invalid immutable resource ID");
    }
    Ok(id.into())
}

fn missing_resource(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.contains("No such container:")
        || text.contains("no such container")
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
            bail!("container engine operation deadline elapsed");
        }
        let child = Command::new(crate::engine::program())
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| {
                format!(
                    "{} is required for boxed sessions",
                    crate::engine::program()
                )
            })?;
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
            bail!("container engine operation timed out: {}", args.join(" "));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "container engine operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8(output.stdout).context("invalid container engine output")
}
fn docker(args: &[&str]) -> anyhow::Result<()> {
    let output = std::process::Command::new(crate::engine::program())
        .args(args)
        .output()
        .with_context(|| {
            format!(
                "{} is required for boxed sessions",
                crate::engine::program()
            )
        })?;
    if !output.status.success() {
        bail!(
            "container engine operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    const OWNED_CONTAINER_FORMAT: &str = r#"{"id":{{json .ID}},"labels":{{json .Config.Labels}}}"#;

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
            hosts: Vec::new(),
        }
    }

    fn image_fixture() -> String {
        serde_json::json!({ "Id": format!("sha256:{}", "d".repeat(64)), "Config": { "Env": ["PATH=/usr/bin"], "User": "node" } }).to_string()
    }
    fn egress_fixture(id: &str, running: bool) -> serde_json::Value {
        serde_json::json!({
            "Id": id, "Image": format!("sha256:{}", "d".repeat(64)),
            "Config": { "Labels": { EGRESS_LABEL: EGRESS_OWNER }, "Entrypoint": ["node"],
                "Cmd": ["/opt/agent-connect/egress-proxy.mjs"], "Env": ["PATH=/usr/bin"], "User": "node" },
            // Docker reports these even when unset (null or empty).
            "HostConfig": { "ReadonlyRootfs": true, "Privileged": false, "CapDrop": ["ALL"], "CapAdd": null,
                "SecurityOpt": ["no-new-privileges"], "Memory": 268435456,
                "NanoCpus": 1000000000, "PidsLimit": 64, "NetworkMode": "bridge",
                "Devices": [], "DeviceRequests": null, "PidMode": "", "IpcMode": "private",
                "Binds": null, "PortBindings": {}, "Tmpfs": null,
                "RestartPolicy": { "Name": "unless-stopped" },
                "LogConfig": { "Type": "json-file", "Config": { "max-size": "10m", "max-file": "3" } } },
            "State": { "Running": running, "Restarting": false }, "Mounts": []
        })
    }

    /// Trimmed from a real rootless Podman 4.9 egress inspection.
    fn podman_egress_fixture() -> serde_json::Value {
        let mut created = vec!["podman".to_string()];
        created.extend(egress_args(
            crate::engine::Program::Podman,
            "owned-egress",
            &"d".repeat(64),
        ));
        serde_json::json!({
            "Id": "c".repeat(64), "Image": "d".repeat(64), "Name": "owned-egress",
            "Config": { "Labels": { EGRESS_LABEL: EGRESS_OWNER }, "Entrypoint": "node",
                "CreateCommand": created,
                "Cmd": ["/opt/agent-connect/egress-proxy.mjs"],
                "Env": ["container=podman", "PATH=/usr/bin", "HOME=/home/node", "HOSTNAME=c0ffee"],
                "User": "node" },
            "EffectiveCaps": null,
            "HostConfig": { "ReadonlyRootfs": true, "Privileged": false,
                "CapDrop": ["CAP_CHOWN", "CAP_KILL"], "CapAdd": [],
                "SecurityOpt": ["no-new-privileges"], "Memory": 268435456,
                "NanoCpus": 1000000000, "PidsLimit": 64, "NetworkMode": "bridge",
                "Devices": [], "PidMode": "private", "IpcMode": "shareable",
                "Binds": [], "PortBindings": {}, "Tmpfs": {},
                "RestartPolicy": { "Name": "unless-stopped" },
                "LogConfig": { "Type": "json-file", "Config": null, "Size": "10MB" } },
            "State": { "Running": true, "Restarting": false,
                "Health": { "Status": "", "FailingStreak": 0, "Log": null } },
            "Mounts": []
        })
    }
    fn podman_image() -> BoxImage {
        BoxImage {
            id: "d".repeat(64),
            env: serde_json::json!(["PATH=/usr/bin"]),
            user: serde_json::json!("node"),
        }
    }
    fn podman_verdict(edit: impl FnOnce(&mut serde_json::Value)) -> anyhow::Result<()> {
        let mut container = podman_egress_fixture();
        edit(&mut container);
        let facts = EgressFacts::read(&container, crate::engine::Program::Podman)?;
        judge_egress(&facts, &podman_image(), true)
    }
    #[test]
    fn podman_egress_is_judged_by_its_own_facts() {
        podman_verdict(|_| {}).unwrap();
        // The same document read as Docker's is refused, never half-trusted.
        let container = podman_egress_fixture();
        assert!(
            EgressFacts::read(&container, crate::engine::Program::Docker)
                .and_then(|facts| judge_egress(&facts, &podman_image(), true))
                .is_err()
        );
    }
    #[test]
    fn podman_egress_refusals() {
        let set = |pointer: &'static str, value: serde_json::Value| {
            move |c: &mut serde_json::Value| *c.pointer_mut(pointer).unwrap() = value
        };
        // A capability back in the container, whatever CapAdd says.
        assert!(podman_verdict(set("/EffectiveCaps", serde_json::json!(["CAP_NET_RAW"]))).is_err());
        // Env: one unknown key, a wrong HOME, or a missing marker.
        let env = |entries: serde_json::Value| set("/Config/Env", entries);
        assert!(
            podman_verdict(env(serde_json::json!([
                "container=podman",
                "PATH=/usr/bin",
                "HOME=/home/node",
                "NODE_OPTIONS=--inspect"
            ])))
            .is_err()
        );
        assert!(
            podman_verdict(env(serde_json::json!([
                "container=podman",
                "PATH=/usr/bin",
                "HOME=/tmp"
            ])))
            .is_err()
        );
        assert!(
            podman_verdict(env(serde_json::json!(["PATH=/usr/bin", "HOME=/home/node"]))).is_err()
        );
        assert!(
            podman_verdict(env(serde_json::json!([
                "container=docker",
                "PATH=/usr/bin"
            ])))
            .is_err()
        );
        // An entrypoint whose argument boundaries cannot be read.
        assert!(
            podman_verdict(set(
                "/Config/Entrypoint",
                serde_json::json!("node --inspect")
            ))
            .is_err()
        );
        assert!(
            podman_verdict(set("/HostConfig/LogConfig/Size", serde_json::json!("0B"))).is_err()
        );
        assert!(
            podman_verdict(set("/HostConfig/Devices", serde_json::json!(["/dev/fuse"]))).is_err()
        );
        // Podman 4 reports no devices; its creation record shows them, and the
        // owner reading the service log learns how to recover.
        let stale = podman_verdict(|c| {
            let created = c["Config"]["CreateCommand"].as_array_mut().unwrap();
            created.insert(1, "/dev/fuse".into());
            created.insert(1, "--device".into());
        })
        .unwrap_err();
        assert!(stale.to_string().contains("setup --upgrade"));
        // A record made for another container's name.
        assert!(podman_verdict(set("/Name", serde_json::json!("other-egress"))).is_err());
        assert!(podman_verdict(set("/HostConfig/Tmpfs", serde_json::json!({"/x": "rw"}))).is_err());
        assert!(
            podman_verdict(|c| {
                c["HostConfig"].as_object_mut().unwrap().remove("Tmpfs");
            })
            .is_err()
        );
        assert!(
            podman_verdict(|c| {
                c["Config"].as_object_mut().unwrap().remove("CreateCommand");
            })
            .is_err()
        );
        // A field the engine should report but did not.
        assert!(
            podman_verdict(|c| {
                c["HostConfig"].as_object_mut().unwrap().remove("PidsLimit");
            })
            .is_err()
        );
        assert!(
            podman_verdict(|c| {
                c.as_object_mut().unwrap().remove("EffectiveCaps");
            })
            .is_err()
        );
    }
    #[test]
    fn docker_egress_missing_fields_fail_closed() {
        let image = BoxImage {
            id: format!("sha256:{}", "d".repeat(64)),
            env: serde_json::json!(["PATH=/usr/bin"]),
            user: serde_json::json!("node"),
        };
        let read = |container: &serde_json::Value| {
            EgressFacts::read(container, crate::engine::Program::Docker)
                .and_then(|facts| judge_egress(&facts, &image, true))
        };
        let container = egress_fixture(&"a".repeat(64), true);
        read(&container).unwrap();
        let mut tmpfs = container.clone();
        tmpfs["HostConfig"]["Tmpfs"] = serde_json::json!({"/x": ""});
        assert!(read(&tmpfs).is_err(), "a --tmpfs mount must refuse");
        let mut omitted = container.clone();
        omitted["HostConfig"]
            .as_object_mut()
            .unwrap()
            .remove("Tmpfs");
        read(&omitted).unwrap();
        for key in ["CapAdd", "Devices", "Binds", "PortBindings"] {
            let mut missing = container.clone();
            missing["HostConfig"].as_object_mut().unwrap().remove(key);
            assert!(read(&missing).is_err(), "{key} absent must refuse");
        }
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
    fn the_podman_keepalive_is_created_started_or_replaced_only_when_ours() {
        use crate::engine::Program;
        let image = BoxImage {
            id: "d".repeat(64),
            env: serde_json::json!([]),
            user: serde_json::json!("node"),
        };
        let id = "a".repeat(64);
        let inspect = [
            "inspect",
            "--type",
            "container",
            "--format",
            "{{json .}}",
            "egress-keepalive",
        ];
        let create = keepalive_args("egress-keepalive", &image.id);
        let create: Vec<&str> = create.iter().map(String::as_str).collect();
        let keepalive = |owner: &str, image: &str, running: bool| {
            serde_json::json!({ "Id": id, "Image": image,
                "Config": { "Labels": { EGRESS_LABEL: owner } }, "State": { "Running": running } })
            .to_string()
        };
        let run = |steps: Vec<(Vec<String>, Result<String, &'static str>)>| {
            let mut docker = Fixture(VecDeque::from(steps));
            let result = ensure_keepalive(
                Program::Podman,
                "egress",
                &image,
                &mut docker,
                Instant::now() + STARTUP_TIMEOUT,
            );
            assert!(docker.0.is_empty());
            result
        };
        run(vec![
            step(&inspect, Err("no such container")),
            step(&create, Ok(&id)),
        ])
        .unwrap();
        let current = keepalive(KEEPALIVE_OWNER, &image.id, true);
        run(vec![step(&inspect, Ok(&current))]).unwrap();
        let stopped = keepalive(KEEPALIVE_OWNER, &image.id, false);
        run(vec![
            step(&inspect, Ok(&stopped)),
            step(&["start", &id], Ok(&id)),
        ])
        .unwrap();
        let older = keepalive(KEEPALIVE_OWNER, &"e".repeat(64), true);
        run(vec![
            step(&inspect, Ok(&older)),
            step(&force_remove(Program::Podman, &id), Ok("")),
            step(&create, Ok(&id)),
        ])
        .unwrap();
        let foreign = keepalive("someone-else", &image.id, true);
        assert!(run(vec![step(&inspect, Ok(&foreign))]).is_err());
        // Docker's daemon keeps its networks; there is nothing to keep alive.
        let mut docker = Fixture(VecDeque::new());
        ensure_keepalive(
            Program::Docker,
            "egress",
            &image,
            &mut docker,
            Instant::now(),
        )
        .unwrap();
    }

    #[test]
    fn egress_start_replaces_only_a_sound_egress_of_another_box() {
        let id = "a".repeat(64);
        let previous = format!("sha256:{}", "e".repeat(64));
        let previous_image = serde_json::json!({ "Id": previous, "Config": { "Env": ["PATH=/usr/bin"], "User": "node" } }).to_string();
        let inspect_egress = [
            "inspect",
            "--type",
            "container",
            "--format",
            "{{json .}}",
            "owned-egress",
        ];
        let current = ["image", "inspect", "--format", "{{json .}}", "session:test"];
        let own = [
            "image",
            "inspect",
            "--format",
            "{{json .}}",
            previous.as_str(),
        ];
        let mut sound = egress_fixture(&id, true);
        sound["Image"] = serde_json::json!(previous);
        let create = egress_start_args("owned-egress", &format!("sha256:{}", "d".repeat(64)));
        let mut docker = Fixture(VecDeque::from([
            step(&current, Ok(&image_fixture())),
            step(&inspect_egress, Ok(&sound.to_string())),
            step(&own, Ok(&previous_image)),
            step(&force_remove(crate::engine::selected(), &id), Ok("")),
            step(
                &create.iter().map(String::as_str).collect::<Vec<_>>(),
                Ok(&id),
            ),
        ]));
        egress_start_with("owned-egress", "session:test", &mut docker).unwrap();
        assert!(docker.0.is_empty());

        // Weakened, unowned, or its own box gone: refused, nothing removed.
        let mut weakened = sound.clone();
        weakened["HostConfig"]["Privileged"] = serde_json::json!(true);
        let mut unowned = sound.clone();
        unowned["Config"]["Labels"] = serde_json::json!({});
        for (container, own_image) in [
            (weakened, Ok(previous_image.as_str())),
            (unowned, Ok(previous_image.as_str())),
            (sound, Err("no such image")),
        ] {
            let mut steps = VecDeque::from([
                step(&current, Ok(&image_fixture())),
                step(&inspect_egress, Ok(&container.to_string())),
            ]);
            if container["Config"]["Labels"] != serde_json::json!({}) {
                steps.push_back(step(&own, own_image));
            }
            let mut docker = Fixture(steps);
            assert!(egress_start_with("owned-egress", "session:test", &mut docker).is_err());
            assert!(docker.0.is_empty());
        }
    }

    #[test]
    fn egress_refuses_unowned_wrong_image_or_modified_proxy() {
        let image = BoxImage {
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
            crate::engine::Program::Docker,
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
            crate::engine::Program::Docker,
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
            crate::engine::Program::Docker,
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
                .contains("box is unavailable")
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
    fn podman_session_network_has_no_dns_and_names_peers_by_address() {
        let network = "a".repeat(64);
        let peer = "b".repeat(64);
        let image = format!("sha256:{}", "d".repeat(64));
        let labels = serde_json::json!({"id": network, "labels": {
            EGRESS_LABEL: SESSION_OWNER, SESSION_LABEL: "test"
        }})
        .to_string();
        let egress = egress_fixture(&peer, true).to_string();
        let egress_inspect = ["inspect", "--type", "container", "--format", "{{json .}}"];
        let mut docker = Fixture(VecDeque::from([
            step(
                &[
                    "network",
                    "create",
                    "--internal",
                    "--disable-dns",
                    "--label",
                    "org.agent-connect.component=acp-session",
                    "--label",
                    "org.agent-connect.session=test",
                    "acp-sess-net-test",
                ],
                Ok("acp-sess-net-test"),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "network",
                    "--format",
                    r#"{"id":{{json .ID}},"labels":{{json .Labels}}}"#,
                    "acp-sess-net-test",
                ],
                Ok(&labels),
            ),
            step(
                &["image", "inspect", "--format", "{{json .}}", "session:test"],
                Ok(&image_fixture()),
            ),
            step(
                &[&egress_inspect[..], &["egress-name"]].concat(),
                Ok(&egress),
            ),
            step(
                &["network", "connect", "--alias", "egress", &network, &peer],
                Ok(""),
            ),
            step(
                &[&egress_inspect[..], &[peer.as_str()]].concat(),
                Ok(&egress),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    r#"{{(index .NetworkSettings.Networks "acp-sess-net-test").IPAddress}}"#,
                    &peer,
                ],
                Ok("10.89.0.2\n"),
            ),
        ]));
        let mut session = SessionNetwork::create_with(
            "test",
            "egress-name",
            None,
            "session:test",
            None,
            crate::engine::Program::Podman,
            &mut docker,
        )
        .unwrap();
        session.cleanup_on_drop = false;
        assert!(docker.0.is_empty());
        assert_eq!(session.hosts, ["egress:10.89.0.2"]);

        let args = box_args(
            Harness::Codex,
            "test",
            "agent-full-access",
            None,
            crate::engine::Program::Podman,
            Engine::Rootless,
            "session:test",
            "acp-sess-net-test",
            false,
        );
        let mut expected = args[1..].to_vec();
        expected[0] = "create".into();
        let pos = expected.iter().position(|arg| arg == "--network").unwrap();
        expected[pos + 1] = network.clone();
        let image_arg = expected.len() - 3;
        expected[image_arg] = image;
        expected.splice(
            image_arg..image_arg,
            ["--add-host".to_string(), "egress:10.89.0.2".into()],
        );
        let mut docker = Fixture(VecDeque::from([(expected, Ok("c".repeat(64)))]));
        session.create_box_with(args, &mut docker).unwrap();
        assert!(docker.0.is_empty());
    }

    #[test]
    fn podman_session_network_refuses_a_peer_without_an_address() {
        let error = network_peer_address_error();
        assert!(
            error.contains("egress has no address on the session network"),
            "{error}"
        );
    }

    fn network_peer_address_error() -> String {
        let network = "a".repeat(64);
        let peer = "b".repeat(64);
        let labels = serde_json::json!({"id": network, "labels": {
            EGRESS_LABEL: SESSION_OWNER, SESSION_LABEL: "test"
        }})
        .to_string();
        let egress = egress_fixture(&peer, true).to_string();
        let mut docker = Fixture(VecDeque::from([
            step(
                &network_create_args(crate::engine::Program::Podman, "test", "acp-sess-net-test")
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                Ok("acp-sess-net-test"),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "network",
                    "--format",
                    r#"{"id":{{json .ID}},"labels":{{json .Labels}}}"#,
                    "acp-sess-net-test",
                ],
                Ok(&labels),
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
                Ok(&egress),
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
                Ok(&egress),
            ),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    r#"{{(index .NetworkSettings.Networks "acp-sess-net-test").IPAddress}}"#,
                    &peer,
                ],
                Ok("<no value>"),
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
            crate::engine::Program::Podman,
            &mut docker,
        )
        .err()
        .unwrap();
        assert!(docker.0.is_empty());
        format!("{error:#}")
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
            crate::engine::Program::Docker,
            Engine::Rootful,
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
            crate::engine::Program::Docker,
            Engine::Rootful,
            "session:test",
            "network-name",
            false,
        );
        let mut create = args[1..].to_vec();
        create[0] = "create".into();
        let pos = create.iter().position(|arg| arg == "--network").unwrap();
        create[pos + 1] = network.clone();
        let inspected = serde_json::json!({"id": container, "labels": {
            EGRESS_LABEL: SESSION_OWNER, SESSION_LABEL: "test"
        }})
        .to_string();
        let mut docker = Fixture(VecDeque::from([
            (create, Err("injected lost create response")),
            step(
                &[
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    OWNED_CONTAINER_FORMAT,
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
        let inspected = serde_json::json!({"id": "b".repeat(64), "labels": {
            EGRESS_LABEL: SESSION_OWNER, SESSION_LABEL: "someone-else"
        }})
        .to_string();
        let mut docker = Fixture(VecDeque::from([step(
            &[
                "inspect",
                "--type",
                "container",
                "--format",
                OWNED_CONTAINER_FORMAT,
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
                crate::engine::Program::Docker,
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
            crate::engine::Program::Docker,
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
                crate::engine::Program::Docker,
                Engine::Rootful,
                "session:test",
                "network-test",
                mock,
            );
            assert!(!args.iter().any(|arg| arg.contains("API_KEY")));
            assert_eq!(args.iter().any(|arg| arg.contains("AUTH_TOKEN")), mock);
            assert_eq!(args.iter().any(|arg| arg.contains("BASE_URL")), mock);
            assert_eq!(
                args.iter().any(|arg| arg == "ENABLE_TOOL_SEARCH=false"),
                mock
            );
            assert!(
                !args
                    .iter()
                    .any(|arg| arg.contains("AGENT_CONNECT_MOCK_MODEL"))
            );
            assert!(args.contains(&"--read-only".into()));
            assert!(args.contains(&"no-new-privileges".into()));
        }
    }
    #[test]
    fn podman_boxes_without_a_home_keep_the_default_mapping() {
        let args = box_args(
            Harness::Codex,
            "test",
            "workspace-write",
            None,
            crate::engine::Program::Podman,
            Engine::RootlessPodman,
            "session:test",
            "network-test",
            false,
        );
        // keep-id would make box files the owner's; without a home they stay
        // on a subordinate id.
        assert!(!args.iter().any(|arg| arg.starts_with("--userns")));
        assert!(!args.contains(&"--user".into()));
        assert!(!args.iter().any(|arg| arg.contains("uid=")));
        assert!(args.contains(&"/work:rw,exec,size=512m,U".into()));
    }
    #[test]
    fn forced_removal_kills_at_once_on_both_engines() {
        use crate::engine::Program;
        assert_eq!(force_remove(Program::Docker, "id"), ["rm", "--force", "id"]);
        assert_eq!(
            force_remove(Program::Podman, "id"),
            ["rm", "--force", "--time", "0", "id"]
        );
    }
    #[test]
    fn podman_egress_starts_on_a_bridge_it_can_leave() {
        use crate::engine::Program;
        let docker = egress_args(Program::Docker, "egress-test", "box:test");
        assert!(!docker.contains(&"--network".into()));
        let podman = egress_args(Program::Podman, "egress-test", "box:test");
        let network = podman.iter().position(|arg| arg == "--network").unwrap();
        assert_eq!(podman[network + 1], "podman");
        assert_eq!(podman[0], "run");
        assert_eq!(&podman[3..], &docker[1..]);
    }
    #[test]
    fn shared_home_box_user_follows_the_engine() {
        let home = HarnessHome {
            path: "/srv/harness-home".into(),
            uid: 1234,
            gid: 2345,
        };
        use crate::engine::Program;
        let run = |program, engine| {
            box_args(
                Harness::Claude,
                "test",
                "workspace-write",
                Some(&home),
                program,
                engine,
                "session:test",
                "network-test",
                false,
            )
        };
        let user =
            |args: &[String]| args[args.iter().position(|a| a == "--user").unwrap() + 1].clone();
        let rootful = run(Program::Docker, Engine::Rootful);
        assert_eq!(user(&rootful), "1234:2345");
        assert!(rootful.contains(&"/work:rw,exec,size=512m,uid=1234,gid=2345".into()));
        assert!(!rootful.iter().any(|arg| arg.contains("IS_SANDBOX")));
        let rootless = run(Program::Docker, Engine::Rootless);
        assert_eq!(user(&rootless), "0:0");
        assert!(rootless.contains(&"/work:rw,exec,size=512m,uid=0,gid=0".into()));
        assert!(rootless.contains(&"IS_SANDBOX=1".into()));
        let podman = run(Program::Podman, Engine::RootlessPodman);
        assert_eq!(user(&podman), "1000:1000");
        assert!(podman.contains(&"--userns=keep-id:uid=1000,gid=1000".into()));
        assert!(podman.contains(&"/work:rw,exec,size=512m,U".into()));
        assert!(!podman.iter().any(|arg| arg.contains("IS_SANDBOX")));
        // Rootful Podman (accepted like any rootful engine) maps ids one to one,
        // but still takes Podman's tmpfs option.
        let rootful_podman = run(Program::Podman, Engine::Rootful);
        assert_eq!(rootful_podman[0], "podman");
        assert_eq!(user(&rootful_podman), "1234:2345");
        assert!(rootful_podman.contains(&"/work:rw,exec,size=512m,U".into()));
        assert!(
            !rootful_podman
                .iter()
                .any(|arg| arg.starts_with("--userns") || arg.contains("uid="))
        );
        for args in [&rootful, &rootless, &podman, &rootful_podman] {
            assert!(args.contains(&"type=bind,src=/srv/harness-home,dst=/home/node".into()));
            assert!(args.contains(&"ALL".into()));
            assert!(args.contains(&"no-new-privileges".into()));
        }
    }
}
