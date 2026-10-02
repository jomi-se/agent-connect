//! Private JSON configuration and first-run setup for the unstable ACP gateway.
use crate::{
    Harness,
    credentials::{HarnessHome, default_home},
    policy::PermissionProfile,
};
use anyhow::Context;
use clap::Args;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path, PathBuf},
};

pub const DEFAULT_SESSION_IMAGE: &str = match option_env!("AGENT_CONNECT_SESSION_IMAGE") {
    Some(image) => image,
    None => "agent-connect-session:0.1.0-alpha.1",
};

#[derive(Debug)]
pub struct UsageError(pub String);
impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UsageError {}
fn usage(message: impl Into<String>) -> anyhow::Error {
    UsageError(message.into()).into()
}

/// CLI and environment fields remain optional so explicit values can override
/// configuration without default CLI values accidentally masking it.
#[derive(Args, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServeOptions {
    /// Private JSON configuration file; paths inside it are relative to its directory.
    #[arg(long, env = "AGENT_CONNECT_CONFIG", hide_env_values = true)]
    #[serde(skip)]
    pub config: Option<PathBuf>,
    /// Harness adapter to launch.
    #[arg(
        long,
        env = "AGENT_CONNECT_HARNESS",
        hide_env_values = true,
        value_enum
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<Harness>,
    /// WebSocket listener address.
    #[arg(long, env = "AGENT_CONNECT_LISTEN", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<SocketAddr>,
    /// Exact browser origin allowed to connect (scheme, host and optional port).
    #[arg(long, env = "AGENT_CONNECT_ALLOW_ORIGIN", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_origin: Option<String>,
    /// Operator-issued bearer for the exact origin and tool snapshot.
    #[arg(long, env = "AGENT_CONNECT_TOKEN", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Approved tool snapshot JSON: array of {name, inputSchema}.
    #[arg(long, env = "AGENT_CONNECT_TOOLS", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<PathBuf>,
    /// Deterministic fixture model URL.
    #[arg(long, env = "AGENT_CONNECT_MOCK_URL", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mock_url: Option<String>,
    /// Operator-selected codex-acp mode.
    #[arg(long, env = "AGENT_CONNECT_CODEX_MODE", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_mode: Option<String>,
    /// Permission profile; native authority is bounded by the container.
    #[arg(
        long,
        env = "AGENT_CONNECT_PERMISSIONS",
        hide_env_values = true,
        value_enum
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionProfile>,
    /// Private dedicated shared harness home (production requires it).
    #[arg(long, env = "AGENT_CONNECT_HARNESS_HOME", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness_home: Option<PathBuf>,
    /// Session image; release builds default to an immutable digest.
    #[arg(long, env = "AGENT_CONNECT_SESSION_IMAGE", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_image: Option<String>,
    /// Egress proxy container attached to internal session networks.
    #[arg(long, env = "AGENT_CONNECT_EGRESS_CONTAINER", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress_container: Option<String>,
    /// Isolated deterministic fixture root; enables host fixtures only.
    #[arg(long, env = "AGENT_CONNECT_MOCK_ROOT", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mock_root: Option<PathBuf>,
    /// Deterministic boxed fixture model container.
    #[arg(long, env = "AGENT_CONNECT_MOCK_CONTAINER", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mock_container: Option<String>,
    /// Private runtime state directory.
    #[arg(long, env = "AGENT_CONNECT_STATE_DIR", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_dir: Option<PathBuf>,
    /// Maximum simultaneously running session hosts.
    #[arg(long, env = "AGENT_CONNECT_MAX_SESSIONS", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_sessions: Option<usize>,
    /// Run every session in an isolated container (required in production).
    #[arg(long, env = "AGENT_CONNECT_BOXED", hide_env_values = true, num_args = 0..=1, default_missing_value = "true", require_equals = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boxed: Option<bool>,
    /// Seconds a detached resumable host remains alive.
    #[arg(long, env = "AGENT_CONNECT_RESUME_GRACE_SECS", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_grace_secs: Option<u64>,
    /// Fixture-compatible named Docker home volumes.
    #[arg(long, env = "AGENT_CONNECT_DURABLE_HOME", hide_env_values = true, num_args = 0..=1, default_missing_value = "true", require_equals = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub durable_home: Option<bool>,
    /// Maximum retained unacknowledged output per resumable host.
    #[arg(long, env = "AGENT_CONNECT_RESUME_MAX_BYTES", hide_env_values = true)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_max_bytes: Option<usize>,
}

#[derive(Clone)]
pub struct ServeCli {
    pub harness: Harness,
    pub listen: SocketAddr,
    pub allow_origin: String,
    pub token: String,
    pub tools: PathBuf,
    pub mock_url: String,
    pub codex_mode: Option<String>,
    pub permissions: PermissionProfile,
    pub harness_home: Option<PathBuf>,
    pub session_image: String,
    pub egress_container: Option<String>,
    pub mock_root: Option<PathBuf>,
    pub mock_container: Option<String>,
    pub state_dir: PathBuf,
    pub max_sessions: usize,
    pub boxed: bool,
    pub resume_grace_secs: u64,
    pub durable_home: bool,
    pub resume_max_bytes: usize,
}
impl ServeOptions {
    pub fn resolve(mut self) -> anyhow::Result<ServeCli> {
        let mut file = if let Some(path) = &self.config {
            read_config(path)?
        } else {
            Self::default()
        };
        macro_rules! merged {
            ($field:ident) => {
                self.$field.take().or_else(|| file.$field.take())
            };
        }
        macro_rules! required {
            ($field:ident) => {
                merged!($field).ok_or_else(|| {
                    usage(format!(
                        "missing --{} (set a flag, environment variable or config field)",
                        stringify!($field).replace('_', "-")
                    ))
                })?
            };
        }
        let mut cli = ServeCli {
            harness: required!(harness),
            listen: merged!(listen).unwrap_or_else(|| "127.0.0.1:18940".parse().unwrap()),
            allow_origin: required!(allow_origin),
            token: required!(token),
            tools: required!(tools),
            mock_url: merged!(mock_url).unwrap_or_else(|| "http://127.0.0.1:18931/v1".into()),
            codex_mode: merged!(codex_mode),
            permissions: merged!(permissions).unwrap_or_else(|| PermissionProfile::Sandboxed),
            harness_home: merged!(harness_home),
            session_image: merged!(session_image).unwrap_or_else(|| DEFAULT_SESSION_IMAGE.into()),
            egress_container: merged!(egress_container),
            mock_root: merged!(mock_root),
            mock_container: merged!(mock_container),
            state_dir: merged!(state_dir)
                .unwrap_or_else(|| PathBuf::from(".agent-connect/gateway")),
            max_sessions: merged!(max_sessions).unwrap_or_else(|| 32),
            boxed: merged!(boxed).unwrap_or_else(|| false),
            resume_grace_secs: merged!(resume_grace_secs).unwrap_or_else(|| 600),
            durable_home: merged!(durable_home).unwrap_or_else(|| false),
            resume_max_bytes: merged!(resume_max_bytes).unwrap_or_else(|| 8 * 1024 * 1024),
        };
        validate_origin(&cli.allow_origin)?;
        if cli.token.is_empty()
            || !cli
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        {
            return Err(usage(
                "grant token must be nonempty and use only letters, digits, - . _ ~",
            ));
        }
        if cli.max_sessions == 0 || cli.resume_max_bytes == 0 {
            return Err(usage(
                "session capacity and retained output limit must be positive",
            ));
        }
        if !cli.boxed && cli.mock_root.is_none() {
            return Err(usage(
                "production sessions require --boxed; host mode requires an isolated --mock-root",
            ));
        }
        if cli.boxed && cli.egress_container.is_none() {
            return Err(usage("--boxed requires --egress-container"));
        }
        if cli.harness_home.is_some() && !cli.boxed {
            return Err(usage("--harness-home requires --boxed"));
        }
        if cli.mock_container.is_some() && cli.mock_root.is_none() {
            return Err(usage("--mock-container requires --mock-root"));
        }
        if cli.boxed && cli.mock_root.is_none() && cli.harness_home.is_none() {
            cli.harness_home = Some(default_home(cli.harness)?);
        }
        if let Some(name) = &cli.egress_container {
            validate_container_name(name)?;
        }
        Ok(cli)
    }
}

/// Read private configuration and resolve paths without requiring server-only
/// fields. Login uses this metadata even when grants are supplied at serve time.
pub fn read_config(path: &Path) -> anyhow::Result<ServeOptions> {
    let bytes = read_private(path)?;
    let mut parsed: ServeOptions =
        serde_json::from_slice(&bytes).map_err(|e| usage(format!("invalid configuration: {e}")))?;
    let config_path = path
        .canonicalize()
        .context("resolve configuration directory")?;
    let base = config_path.parent().unwrap_or(Path::new("/"));
    for entry in [
        &mut parsed.tools,
        &mut parsed.harness_home,
        &mut parsed.state_dir,
        &mut parsed.mock_root,
    ] {
        if let Some(value) = entry {
            if value.is_relative() {
                *value = base.join(&*value);
            }
        }
    }
    Ok(parsed)
}

fn read_private(path: &Path) -> anyhow::Result<Vec<u8>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return usage("configuration must be a regular private file, not a symlink");
        }
        anyhow::Error::new(error).context("open private configuration")
    })?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(usage("configuration must be a regular private file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(usage(
                "configuration must be owned by the invoking user with mode 0600 or stricter",
            ));
        }
    }
    #[cfg(not(unix))]
    {
        return Err(usage(
            "private configuration currently supports Unix hosts only",
        ));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(usage("configuration exceeds 1 MiB"));
    }
    Ok(bytes)
}

pub fn load_snapshot(path: &Path) -> anyhow::Result<BTreeMap<String, Value>> {
    let source = std::fs::read(path).context("read approved tool snapshot")?;
    snapshot_from_bytes(&source)
}

fn snapshot_from_bytes(source: &[u8]) -> anyhow::Result<BTreeMap<String, Value>> {
    let tools: Vec<Value> =
        serde_json::from_slice(source).map_err(|e| usage(format!("invalid snapshot JSON: {e}")))?;
    let mut snapshot = BTreeMap::new();
    for tool in tools {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| usage("snapshot tool name required"))?;
        let schema = tool
            .get("inputSchema")
            .filter(|s| s.is_object())
            .ok_or_else(|| usage("snapshot tool schema required"))?;
        if snapshot.insert(name.to_string(), schema.clone()).is_some() {
            return Err(usage("duplicate snapshot tool"));
        }
    }
    Ok(snapshot)
}

fn validate_origin(origin: &str) -> anyhow::Result<()> {
    let uri: axum::http::Uri = origin.parse().map_err(|_| {
        usage("--allow-origin must be an exact http:// or https:// origin without a path")
    })?;
    let scheme = uri.scheme_str().unwrap_or("");
    let authority = uri.authority().map(|a| a.as_str()).unwrap_or("");
    if !matches!(scheme, "http" | "https")
        || authority.is_empty()
        || authority.contains('@')
        || origin != format!("{scheme}://{authority}")
    {
        return Err(usage(
            "--allow-origin must be an exact http:// or https:// origin without a path, query or credentials",
        ));
    }
    Ok(())
}

pub fn validate_container_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(usage(
            "container name must start with a letter or digit and contain only letters, digits, _ . -",
        ));
    }
    Ok(())
}

#[derive(Args)]
pub struct InitCli {
    /// New private runtime directory; setup refuses any existing destination.
    #[arg(long)]
    pub directory: PathBuf,
    #[arg(long, value_enum)]
    pub harness: Harness,
    /// Dedicated whole home; defaults to the same per-harness home used by login.
    #[arg(long, env = "AGENT_CONNECT_HARNESS_HOME", hide_env_values = true)]
    pub harness_home: Option<PathBuf>,
    #[arg(long)]
    pub allow_origin: String,
    /// Approved snapshot to validate and copy before issuing the grant.
    #[arg(long)]
    pub tools: PathBuf,
    #[arg(long, default_value = "127.0.0.1:18940")]
    pub listen: SocketAddr,
    #[arg(long, env = "AGENT_CONNECT_SESSION_IMAGE", default_value = DEFAULT_SESSION_IMAGE)]
    pub session_image: String,
    #[arg(long, alias = "egress-name", default_value = "agent-connect-egress")]
    pub egress_container: String,
}

pub fn init(cli: InitCli) -> anyhow::Result<()> {
    validate_origin(&cli.allow_origin)?;
    validate_container_name(&cli.egress_container)?;
    if cli.listen.port() == 0 {
        return Err(usage(
            "init requires a nonzero listener port for the application grant",
        ));
    }
    // Read and validate once; copy exactly the bytes that were validated.
    let source = std::fs::read(&cli.tools).context("read approved tool snapshot")?;
    snapshot_from_bytes(&source)?;
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&cli.directory).context("create new private runtime directory; destination must not exist and its parent must exist")?;
    let directory = cli.directory.canonicalize()?;
    let result = (|| -> anyhow::Result<()> {
        let home_path = cli
            .harness_home
            .clone()
            .map(Ok)
            .unwrap_or_else(|| default_home(cli.harness))?;
        let home = HarnessHome::prepare(&home_path)?;
        builder.create(directory.join("state"))?;
        write_private(&directory.join("tools.json"), &source)?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let configuration = ServeOptions {
            harness: Some(cli.harness),
            listen: Some(cli.listen),
            allow_origin: Some(cli.allow_origin.clone()),
            token: Some(token.clone()),
            tools: Some("tools.json".into()),
            harness_home: Some(home.path),
            state_dir: Some("state".into()),
            boxed: Some(true),
            session_image: Some(cli.session_image.clone()),
            egress_container: Some(cli.egress_container.clone()),
            ..Default::default()
        };
        write_private(
            &directory.join("config.json"),
            &serde_json::to_vec_pretty(&configuration)?,
        )?;
        let mut address = cli.listen;
        if address.ip().is_unspecified() {
            address.set_ip(if address.is_ipv4() {
                "127.0.0.1".parse().unwrap()
            } else {
                "::1".parse().unwrap()
            });
        }
        let grant =
            serde_json::json!({"gatewayUrl": format!("ws://{address}/acp"), "token": token});
        write_private(
            &directory.join("grant.json"),
            &serde_json::to_vec_pretty(&grant)?,
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        // Only the newly-created, owned directory is removed on a failed setup.
        let _ = std::fs::remove_dir_all(&directory);
        return Err(error);
    }
    println!("Created private runtime directory: {}", directory.display());
    println!("Configuration: {}", directory.join("config.json").display());
    println!(
        "Application grant (keep private): {}",
        directory.join("grant.json").display()
    );
    println!(
        "Next: agent-connect egress start --name {} --session-image {}",
        shell_quote(&cli.egress_container),
        shell_quote(&cli.session_image)
    );
    if cli.harness_home.is_none() && cli.session_image == DEFAULT_SESSION_IMAGE {
        println!(
            "Next: agent-connect login (choose {})",
            match cli.harness {
                Harness::Codex => "Codex",
                Harness::Claude => "Claude Code",
            }
        );
    } else {
        println!(
            "Next: agent-connect login --config {}",
            shell_quote(&directory.join("config.json").to_string_lossy())
        );
    }
    println!(
        "Next: agent-connect serve --config {}",
        shell_quote(&directory.join("config.json").to_string_lossy())
    );
    Ok(())
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_validation_rejects_duplicates_and_invalid_schemas() {
        assert!(snapshot_from_bytes(br#"[{"name":"read","inputSchema":{}}]"#).is_ok());
        for source in [
            br#"[{"name":"" ,"inputSchema":{}}]"#.as_slice(),
            br#"[{"name":"read","inputSchema":[]}]"#.as_slice(),
            br#"[{"name":"read","inputSchema":{}},{"name":"read","inputSchema":{}}]"#.as_slice(),
            br#"{}"#.as_slice(),
        ] {
            assert!(
                snapshot_from_bytes(source)
                    .unwrap_err()
                    .downcast_ref::<UsageError>()
                    .is_some()
            );
        }
    }

    #[test]
    fn exact_origins_and_container_names_are_required() {
        for origin in [
            "https://app.example",
            "http://localhost:3000",
            "http://[::1]:3000",
        ] {
            assert!(validate_origin(origin).is_ok(), "{origin}");
        }
        for origin in [
            "*",
            "null",
            "https://app.example/",
            "https://app.example/path",
            "https://user:pass@app.example",
            "https://app.example?secret=1",
        ] {
            assert!(validate_origin(origin).is_err(), "{origin}");
        }
        for name in ["", "--host", "some container", "../container"] {
            assert!(validate_container_name(name).is_err());
        }
    }

    #[test]
    fn unknown_configuration_fields_are_rejected() {
        assert!(
            serde_json::from_str::<ServeOptions>(r#"{"allow_origins":["https://app.example"]}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<ServeOptions>(r#"{"config":"other.json"}"#).is_err());
    }

    #[test]
    fn config_paths_resolve_relative_to_file_and_explicit_fields_override_it() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let path = root.join("config.json");
        write_private(&path, br#"{"harness":"codex","listen":"127.0.0.1:9","allow_origin":"https://app.example","token":"fixture","tools":"tools.json","mock_root":"fixture","state_dir":"state"}"#).unwrap();
        let options = ServeOptions {
            config: Some(path.clone()),
            listen: Some("127.0.0.1:0".parse().unwrap()),
            ..Default::default()
        };
        let resolved = options.resolve().unwrap();
        assert_eq!(resolved.listen.port(), 0);
        assert_eq!(resolved.tools, root.join("tools.json"));
        assert_eq!(resolved.state_dir, root.join("state"));
        assert_eq!(resolved.mock_root, Some(root.join("fixture")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt, symlink};
            let link = root.join("link.json");
            symlink(&path, &link).unwrap();
            assert!(read_private(&link).is_err());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(
                read_private(&path)
                    .unwrap_err()
                    .downcast_ref::<UsageError>()
                    .is_some()
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shell_commands_quote_paths_safely() {
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
    }
}
