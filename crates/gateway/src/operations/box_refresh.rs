//! A serving gateway keeps its locally built box on the latest harness
//! releases (or the owner's pins): it builds the new box beside the running
//! one, and swaps the egress and the configuration only while no session runs.
use super::box_build;
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How often the gateway asks npm whether a newer harness is out.
pub const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// What doctor and the next start read about the last refresh. Times are Unix
/// seconds.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refreshed_at: Option<u64>,
    /// A built box waiting for every session to end before it is swapped in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The box in use before the last swap, kept for rollback until the next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub fn state_path(state_dir: &Path) -> PathBuf {
    state_dir.join("box-refresh.json")
}

/// A missing or unreadable state reads as never checked.
pub fn load(path: &Path) -> RefreshState {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, state: &RefreshState) -> anyhow::Result<()> {
    let staging = path.with_file_name(format!(".box-refresh-{}", uuid::Uuid::new_v4()));
    let result = super::private_write(&staging, &serde_json::to_vec_pretty(state)?)
        .and_then(|()| Ok(std::fs::rename(&staging, path)?));
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

pub async fn installed(image: &str) -> bool {
    box_build::installed(image).await.unwrap_or(false)
}

/// The box a refresh would swap in, built and ready, or `None` when `current`
/// is already the box for the current releases. Never touches the running
/// egress or the configuration.
pub async fn prepare(current: &str, warm: bool) -> anyhow::Result<Option<String>> {
    let harness = box_build::resolve_harness().await?;
    let desired = box_build::desired_image(&harness)?;
    if desired == current {
        return Ok(None);
    }
    // On a failed build ensure_box falls back to `current`.
    if box_build::ensure_box(&desired, Some(current), Some(&harness)).await? != desired {
        bail!("building box {desired} failed; {current} stays in use");
    }
    if warm {
        box_build::warm_owner_mapping(&desired).await?;
    }
    Ok(Some(desired))
}

/// Moves the egress and then the configuration from `current` to `new`, and
/// puts the egress back on `current` if either step fails. Blocking; the
/// caller holds every session permit. A crash between the steps is undone by
/// the next `egress start --config`, which replaces an egress of another box.
pub fn swap(config: &Path, egress: &str, current: &str, new: &str) -> anyhow::Result<()> {
    let result = crate::sandbox::egress_start(egress, new)
        .and_then(|()| super::record_config_value(config, "box_image", new.into()));
    if let Err(error) = result {
        if let Err(rollback) = crate::sandbox::egress_start(egress, current) {
            return Err(error.context(format!(
                "and the egress could not be put back on {current}: {rollback:#}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

/// Removes a box an earlier refresh retired, unless the configuration names
/// it, it is in `keep`, or it is not one this gateway builds.
pub async fn remove_retired(image: &str, config: &Path, keep: &[&str]) -> anyhow::Result<()> {
    let configured: serde_json::Value = serde_json::from_slice(&std::fs::read(config)?)?;
    if !crate::config::locally_built_box(image)
        || configured.get("box_image").and_then(|v| v.as_str()) == Some(image)
        || keep.contains(&image)
        || image == box_build::base_image()?
        || !box_build::installed(image).await?
    {
        return Ok(());
    }
    let output = tokio::process::Command::new(crate::engine::program())
        .args(["image", "rm", image])
        .output()
        .await
        .context("the container engine is required to remove a retired box")?;
    if !output.status.success() {
        bail!(
            "could not remove retired box {image}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_and_a_missing_file_is_never_checked() {
        let directory = std::env::temp_dir().join(format!("acp-refresh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = state_path(&directory);
        assert_eq!(load(&path), RefreshState::default());
        let state = RefreshState {
            checked_at: Some(1),
            pending: Some("agent-connect-box:0.0.4-0123456789abcdef".into()),
            error: Some("npm unreachable".into()),
            ..Default::default()
        };
        save(&path, &state).unwrap();
        save(&path, &state).unwrap();
        assert_eq!(load(&path), state);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(load(&path), RefreshState::default());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn retired_boxes_never_include_the_configured_kept_or_foreign_ones() {
        let directory = std::env::temp_dir().join(format!("acp-refresh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let config = directory.join("config.json");
        let configured = "agent-connect-box:0.0.4-0123456789abcdef";
        let kept = "agent-connect-box:0.0.4-fedcba9876543210";
        std::fs::write(&config, format!(r#"{{"box_image":"{configured}"}}"#)).unwrap();
        // Each of these returns before asking the engine anything.
        for image in [
            configured,
            kept,
            "example/box:1",
            "agent-connect-box:latest",
        ] {
            remove_retired(image, &config, &[kept]).await.unwrap();
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
