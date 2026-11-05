//! Containers that carry the egress owner label and the egress proxy's own
//! arguments, with one weakening each: the gateway must refuse every one of
//! them as its egress. It needs a real engine and box, so it runs only when
//! asked:
//!
//!   ACP_BOX_IMAGE=<box> AGENT_CONNECT_CONTAINER_ENGINE=docker|podman \
//!     cargo test -p agent-connect-gateway --test egress_impostors -- --ignored
//!
//! It creates only the containers acp-impostor and, on Podman, the gateway's
//! acp-impostor-keepalive, refuses to start if either already exists, and
//! removes both when it ends. A weakening the engine refuses to create cannot
//! be impersonated and is skipped; a run that skips them all fails.
use agent_connect_gateway::engine::{self, Program};
use agent_connect_gateway::sandbox::egress_start;
use std::process::Command;

const NAME: &str = "acp-impostor";

const WEAKENINGS: &[&str] = &[
    "--privileged",
    "--security-opt seccomp=unconfined",
    "--security-opt apparmor=unconfined",
    "--pid=host",
    "--network=host",
    "-v /tmp:/impostor",
    "--mount type=tmpfs,dst=/impostor",
    "--device /dev/fuse",
    "-p 3128:3128",
    "--memory=512m",
    "-e NODE_OPTIONS=--inspect",
    "--cap-add=NET_RAW",
];

fn exists(name: &str) -> bool {
    Command::new(engine::program())
        .args(["inspect", "--type", "container", name])
        .output()
        .is_ok_and(|output| output.status.success())
}

fn remove(name: &str) {
    let _ = Command::new(engine::program())
        .args(["rm", "--force", name])
        .output();
}

struct Cleanup;
impl Drop for Cleanup {
    fn drop(&mut self) {
        remove(NAME);
        remove(&format!("{NAME}-keepalive"));
    }
}

/// A hand-made container under the egress's name, with the proxy's arguments
/// and `weakening`; false when the engine refuses to create it.
fn impostor(image: &str, weakening: &str) -> bool {
    remove(NAME);
    let podman = engine::selected() == Program::Podman;
    let mut command = Command::new(engine::program());
    command.arg("run");
    // The gateway starts a Podman egress on the default bridge; a case that
    // chooses its own network replaces it, since Podman takes only one.
    if podman && !weakening.contains("--network") {
        command.args(["--network", "podman"]);
    }
    command.args([
        "--detach",
        "--name",
        NAME,
        "--label",
        "org.agent-connect.component=acp-egress",
        "--restart=unless-stopped",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory=256m",
        "--cpus=1",
        "--pids-limit=64",
    ]);
    // The gateway's bounded logs: the journal on Podman, json-file on Docker.
    if podman {
        command.arg("--log-driver=journald");
    } else {
        command.args([
            "--log-driver=json-file",
            "--log-opt",
            "max-size=10m",
            "--log-opt",
            "max-file=3",
        ]);
    }
    // A later flag overrides the baseline's (--memory).
    command.args(weakening.split_whitespace());
    command.args([
        "--entrypoint",
        "node",
        image,
        "/opt/agent-connect/egress-proxy.mjs",
    ]);
    command.output().is_ok_and(|output| output.status.success())
}

#[test]
#[ignore = "needs a container engine and a box image"]
fn the_gateway_refuses_every_weakened_impostor() {
    let image = std::env::var("ACP_BOX_IMAGE").expect("ACP_BOX_IMAGE names the box");
    engine::select(
        match std::env::var("AGENT_CONNECT_CONTAINER_ENGINE").as_deref() {
            Ok("podman") => Program::Podman,
            _ => Program::Docker,
        },
    );
    for name in [NAME.to_string(), format!("{NAME}-keepalive")] {
        assert!(
            !exists(&name),
            "{name} already exists and is not this test's"
        );
    }
    let _cleanup = Cleanup;
    // The gateway's own egress must be created and then pass revalidation, or
    // every refusal below proves nothing.
    egress_start(NAME, &image).expect("the gateway creates its own egress");
    egress_start(NAME, &image).expect("the gateway revalidates its own egress");
    let mut accepted = Vec::new();
    // On Podman the creation record alone refuses any hand-made container; this
    // one has no weakening, so its refusal shows that layer is in force.
    if engine::selected() == Program::Podman {
        assert!(impostor(&image, ""));
        if egress_start(NAME, &image).is_ok() {
            accepted.push("(hand-made, unweakened)");
        }
    }
    let mut tried = 0;
    for weakening in WEAKENINGS {
        if !impostor(&image, weakening) {
            eprintln!("skipped {weakening}: the engine refused to create it");
            continue;
        }
        tried += 1;
        if egress_start(NAME, &image).is_ok() {
            accepted.push(weakening);
        }
    }
    assert!(
        tried > 0,
        "every weakening was skipped: the matrix proves nothing"
    );
    assert!(accepted.is_empty(), "accepted as the egress: {accepted:?}");
}
