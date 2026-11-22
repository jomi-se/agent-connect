//! Gateway-owned owner authentication and exact-origin OAuth grants.
//!
//! ACP and MCP-over-ACP remain unstable. Application bearers are never owner
//! credentials. Keep this service's private state outside every harness home.
use crate::{
    Harness,
    client_address::{ClientAddressPolicies, ClientSource},
    policy::PermissionProfile,
};
use anyhow::{Result, anyhow, bail, ensure};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::Response,
    routing::any,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::{
    fd::AsRawFd,
    unix::fs::{OpenOptionsExt, PermissionsExt},
};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::Write,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use url::Url;
use webauthn_rs::prelude::{
    Passkey, PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Uuid, Webauthn, WebauthnBuilder,
};

const OWNER: &str = "/agent-connect/owner";
const LOGIN: &str = "/agent-connect/owner/login";
const AUTHORIZE: &str = "/agent-connect/oauth/authorize";
const TOKEN: &str = "/agent-connect/oauth/token";
const PAR: &str = "/agent-connect/oauth/par";
const REVOKE: &str = "/agent-connect/oauth/revoke";
const ENROLL_TOTP: &str = "/agent-connect/owner/totp/verify";
const ENROLL_PASSKEY: &str = "/agent-connect/owner/passkey/enroll";
const REMOVE_FACTOR: &str = pages::REMOVE_FACTOR;
const REQUEST_TTL: u64 = 600;
const CODE_TTL: u64 = 120;
const ACCESS_TTL: u64 = 300;
const MAX_DURATION: u64 = 30 * 24 * 3600;
const MAX_TRANSIENT: usize = 256;
// Additional limits only when explicit proxy trust is configured. Global limits stay unchanged.
const CLIENT_REQUEST_LIMIT: u32 = 60;
const CLIENT_SIGN_IN_LIMIT: usize = 8;
const MAX_CLIENT_BUDGETS: usize = 1024;
const MAX_GRANTS: usize = 256;
const MAX_BODY: usize = 128 * 1024;
const MAX_SPENT_REFRESH: usize = 16384;
const MAX_STATE: u64 = 32 * 1024 * 1024;
const STATE_VERSION: u32 = 2;
const SETUP_TTL: u64 = 600;
const OWNER_TTL: u64 = 12 * 3600;
const CEREMONY_TTL: u64 = 600;
const MAX_CEREMONIES: usize = 8;
const MAX_CREDENTIAL: usize = 16 * 1024;

struct OwnerCookiePolicy {
    name: String,
    path: &'static str,
    secure: bool,
}
impl OwnerCookiePolicy {
    /// Browsers share cookies across the ports of one host, so the name carries
    /// the port: signing in on one address never replaces another's cookie.
    fn for_origin(origin: &str) -> Self {
        let port = Url::parse(origin)
            .ok()
            .and_then(|url| url.port_or_known_default())
            .unwrap_or(0);
        if origin.starts_with("https:") {
            Self {
                name: format!("__Host-agent_connect_owner_{port}"),
                path: "/",
                secure: true,
            }
        } else {
            Self {
                name: format!("agent_connect_owner_{port}"),
                path: "/agent-connect",
                secure: false,
            }
        }
    }

    fn header(&self, value: &str, max_age: u64) -> HeaderValue {
        HeaderValue::from_str(&format!(
            "{}={value}; Path={}; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
            self.name,
            self.path,
            if self.secure { "; Secure" } else { "" },
        ))
        .expect("generated owner cookie is a valid header")
    }
}

// Only constructed after validating the sign-in origin, session, CSRF and
// pending request. The endpoint keeps one shared status/error mapping.
#[derive(Debug)]
struct SignInRetry {
    reason: anyhow::Error,
    target: String,
}
impl std::fmt::Display for SignInRetry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.reason)
    }
}
impl std::error::Error for SignInRetry {}

pub struct AuthConfig {
    /// A canonical HTTPS origin, or an HTTP loopback origin for local use.
    pub public_url: String,
    pub state_dir: PathBuf,
    pub policy_fingerprint: String,
    /// Additional trusted origins; each grant uses its selected entry-point issuer.
    pub entry_points: Vec<String>,
    pub client_address_policies: ClientAddressPolicies,
    pub profiles: Vec<PermissionProfile>,
    pub default_profile: PermissionProfile,
    pub harness: Harness,
    /// Required only when bootstrapping a new state directory. Never persisted.
    pub owner_passphrase: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AuthorizedGrant {
    pub id: String,
    /// Exact configured entry point for the grant bearer audience.
    pub issuer: String,
    pub permissions: PermissionProfile,
    pub snapshot: BTreeMap<String, Value>,
    pub tool_definitions: BTreeMap<String, Value>,
    pub access_expires_at: u64,
    epoch: String,
    access_hash: String,
}

/// Runtime state exposed only after owner authentication. Values contain no tokens
/// or provider credentials. Callbacks must not acquire the authorization lock.
#[derive(Clone, Debug, Default)]
pub struct OwnerRuntimeSnapshot {
    pub problems: Vec<OwnerProblem>,
    pub sessions: Vec<OwnerSession>,
}
#[derive(Clone, Debug)]
pub struct OwnerProblem {
    pub message: String,
    pub repair: String,
}
#[derive(Clone, Debug)]
pub struct OwnerSession {
    pub id: String,
    pub grant_id: String,
    pub state: String,
    pub started_at: u64,
}
pub trait OwnerRuntime: Send + Sync {
    fn snapshot(&self) -> OwnerRuntimeSnapshot;
    /// Queue termination and owned resource cleanup. A grant remains unchanged.
    fn end_session(&self, id: &str) -> Result<()>;
}

pub struct AuthService {
    config: AuthConfig,
    inner: Mutex<Inner>,
    runtime: Mutex<Option<Arc<dyn OwnerRuntime>>>,
    sign_in_audit: Mutex<sign_in_audit::Audit>,
    // Holding the file holds the exclusive process lock until service shutdown.
    _lock: File,
    requests: tokio::sync::Semaphore,
    #[cfg(test)]
    clock: std::sync::atomic::AtomicU64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u32,
    issuer: String,
    password_hash: String,
    /// One second factor per configured origin. Records for an origin removed
    /// from configuration are kept, not erased.
    factors: BTreeMap<String, Factor>,
    grants: Vec<Grant>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Factor {
    Passkey {
        user: Uuid,
        passkey: Box<Passkey>,
    },
    Totp {
        secret: String,
        last_step: Option<u64>,
    },
}
/// What a host-side factor removal covers: one exact address, or all of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FactorTarget {
    Address(String),
    All,
}
/// One address's stored passkey or authenticator, as the terminal lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredFactor {
    pub address: String,
    pub passkey: bool,
}
/// What the owner chooses from before a host-side factor removal.
#[derive(Debug)]
pub struct StoredFactors {
    pub factors: Vec<StoredFactor>,
    /// App grants still in force; a removal revokes them all.
    pub apps_with_access: usize,
}
/// The origin an address names, as factors are stored: a trailing slash or
/// path is dropped. `None` when it is not an address.
pub fn factor_address(address: &str) -> Option<String> {
    Url::parse(address)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .filter(|origin| origin != "null")
}
/// Result of host-side factor removal.
#[derive(Debug, PartialEq, Eq)]
pub struct FactorRemoval {
    pub removed: Vec<String>,
    pub revoked_grants: usize,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FactorKind {
    Passkey,
    Totp,
}
impl Factor {
    fn kind(&self) -> FactorKind {
        match self {
            Factor::Passkey { .. } => FactorKind::Passkey,
            Factor::Totp { .. } => FactorKind::Totp,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    id: String,
    epoch: String,
    client: String,
    fingerprint: String,
    /// Absent only in legacy grants, whose default authority is preserved on upgrade.
    #[serde(default)]
    profile: Option<PermissionProfile>,
    /// Entry-point issuer approved with this grant; old grants use canonical issuer.
    #[serde(default)]
    issuer: Option<String>,
    tools: Vec<Tool>,
    expires: u64,
    revoked: bool,
    /// Activity times; absent on grants stored before they were recorded.
    #[serde(default)]
    approved_at: Option<u64>,
    #[serde(default)]
    revoked_at: Option<u64>,
    /// The name the application declared when it was approved, shown with its origin.
    #[serde(default)]
    name: Option<String>,
    access_hash: Option<String>,
    access_expires: u64,
    refresh_hash: Option<String>,
    spent: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Tool {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    schema: Value,
}
#[derive(Clone)]
struct Pending {
    issuer: String,
    client: String,
    client_name: String,
    redirect: String,
    state: String,
    challenge: String,
    tools: Vec<Tool>,
    expires: u64,
}
#[derive(Clone)]
struct Code {
    request: Pending,
    grant: String,
    expires: u64,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Authority {
    Anonymous,
    /// Knows the passphrase on an address with no factor: may enroll one, nothing else.
    Setup,
    /// Signed in with the address's factor.
    Owner(FactorKind),
}
struct Session {
    // Admission accounting only; never checked when accepting a session or CSRF.
    source: Option<ClientSource>,
    origin: String,
    expires: u64,
    authority: Authority,
    enrollment: Option<Enrollment>,
    /// Pending passkey assertions, by purpose (`login:…`, `consent:…`). Single use.
    ceremonies: HashMap<String, (PasskeyAuthentication, u64)>,
    /// Where a setup session goes once its factor is enrolled.
    continuation: String,
}
#[derive(Clone)]
enum Enrollment {
    Totp {
        secret: String,
        expires: u64,
    },
    Passkey {
        user: Uuid,
        state: PasskeyRegistration,
        expires: u64,
    },
}
impl Session {
    fn new(origin: String, authority: Authority, expires: u64) -> Self {
        Self {
            source: None,
            origin,
            expires,
            authority,
            enrollment: None,
            ceremonies: HashMap::new(),
            continuation: String::new(),
        }
    }
}
struct Csrf {
    session: String,
    action: String,
    expires: u64,
}
#[derive(Default)]
struct AttemptBudget {
    window: u64,
    count: u32,
}
struct Inner {
    stored: Stored,
    pending: HashMap<String, Pending>,
    codes: HashMap<String, Code>,
    sessions: HashMap<String, Session>,
    anonymous: HashMap<String, Session>,
    anonymous_csrf: HashMap<String, Csrf>,
    csrf: HashMap<String, Csrf>,
    broken: bool,
    rate_window: u64,
    rate_count: u32,
    login_budgets: HashMap<ClientSource, AttemptBudget>,
    factor_budgets: HashMap<ClientSource, AttemptBudget>,
    request_budgets: HashMap<ClientSource, AttemptBudget>,
}

impl AuthService {
    pub fn open(mut config: AuthConfig) -> Result<Arc<Self>> {
        canonical_origin(&config.public_url)?;
        ensure!(config.entry_points.len() <= 16, "too many entry points");
        let mut origins = std::collections::HashSet::from([config.public_url.clone()]);
        let mut authorities = std::collections::HashSet::from([Url::parse(&config.public_url)?
            [url::Position::BeforeHost..url::Position::AfterPort]
            .to_string()]);
        for origin in &config.entry_points {
            canonical_origin(origin)?;
            ensure!(origins.insert(origin.clone()), "duplicate entry point");
            ensure!(
                authorities.insert(
                    Url::parse(origin)?[url::Position::BeforeHost..url::Position::AfterPort]
                        .to_string()
                ),
                "entry point host and port must be unique"
            );
        }
        config.client_address_policies.validate(
            std::iter::once(config.public_url.as_str())
                .chain(config.entry_points.iter().map(String::as_str)),
        )?;
        ensure!(
            !config.profiles.is_empty()
                && config.profiles.len() <= 4
                && config.profiles.contains(&config.default_profile),
            "invalid configured profiles"
        );
        let mut profiles = std::collections::HashSet::new();
        for profile in &config.profiles {
            ensure!(profiles.insert(profile.as_str()), "duplicate profile");
            ensure!(
                !(config.harness == Harness::Claude && *profile == PermissionProfile::ReadOnly),
                "Claude read-only profile unavailable"
            );
        }
        ensure!(
            !config.policy_fingerprint.is_empty() && config.policy_fingerprint.len() <= 512,
            "invalid policy fingerprint"
        );
        private_directory(&config.state_dir)?;
        let lock = authorization_lock(&config.state_dir)?;
        let path = config.state_dir.join("authorization.json");
        let stored = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && metadata.len() <= MAX_STATE,
                    "invalid authorization state file"
                );
                #[cfg(unix)]
                ensure!(
                    metadata.permissions().mode() & 0o077 == 0,
                    "authorization state must be private"
                );
                let bytes = fs::read(&path)?;
                let version = serde_json::from_slice::<Value>(&bytes)?
                    .get("version")
                    .and_then(Value::as_u64);
                ensure!(
                    version == Some(STATE_VERSION.into()),
                    "owner authorization state at {} is from an earlier Agent Connect version: remove it and run setup again",
                    path.display()
                );
                let stored: Stored = serde_json::from_slice(&bytes)?;
                ensure!(
                    stored.issuer == config.public_url && stored.grants.len() <= MAX_GRANTS,
                    "authorization state does not match gateway"
                );
                PasswordHash::new(&stored.password_hash)
                    .map_err(|_| anyhow!("invalid stored owner hash"))?;
                for (origin, factor) in &stored.factors {
                    canonical_origin(origin)?;
                    if let Factor::Totp { secret, .. } = factor {
                        ensure!(decode_secret(secret)?.len() == 20, "invalid stored factor");
                    }
                }
                for grant in &stored.grants {
                    canonical_origin(&grant.client)?;
                    if let Some(issuer) = &grant.issuer {
                        canonical_origin(issuer)?;
                    }
                    validate_tools(&serde_json::to_value(&grant.tools)?)?;
                    ensure!(
                        grant.spent.len() <= MAX_SPENT_REFRESH,
                        "invalid stored token history"
                    );
                }
                stored
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let passphrase = config
                    .owner_passphrase
                    .as_deref()
                    .ok_or_else(|| anyhow!("first boot requires an owner passphrase"))?;
                let hash = hash_passphrase(passphrase)?;
                let stored = Stored {
                    version: STATE_VERSION,
                    issuer: config.public_url.clone(),
                    password_hash: hash,
                    factors: BTreeMap::new(),
                    grants: Vec::new(),
                };
                save(&config.state_dir, &stored)?;
                stored
            }
            Err(error) => return Err(error.into()),
        };
        config.owner_passphrase = None;
        Ok(Arc::new(Self {
            config,
            _lock: lock,
            runtime: Mutex::new(None),
            sign_in_audit: Mutex::new(sign_in_audit::Audit::default()),
            requests: tokio::sync::Semaphore::new(32),
            inner: Mutex::new(Inner {
                stored,
                pending: HashMap::new(),
                codes: HashMap::new(),
                sessions: HashMap::new(),
                anonymous: HashMap::new(),
                anonymous_csrf: HashMap::new(),
                csrf: HashMap::new(),
                broken: false,
                rate_window: 0,
                rate_count: 0,
                login_budgets: HashMap::new(),
                factor_budgets: HashMap::new(),
                request_budgets: HashMap::new(),
            }),
            #[cfg(test)]
            clock: std::sync::atomic::AtomicU64::new(1_700_000_000),
        }))
    }

    /// Public readiness projection: never exposes owner or grant data.
    pub fn healthy(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| !inner.broken)
    }

    pub fn set_runtime(&self, runtime: Arc<dyn OwnerRuntime>) -> Result<()> {
        *self
            .runtime
            .lock()
            .map_err(|_| anyhow!("runtime unavailable"))? = Some(runtime);
        Ok(())
    }

    /// Owner-run recovery only, refused while the gateway runs and never
    /// creating missing state: put one address, or every address, back to
    /// setup and revoke every app grant. The passphrase is kept. `choose` sees
    /// the stored factors under the state lock and returns what to remove, or
    /// `None` to leave state unchanged. Returns the addresses whose factor was
    /// removed and how many app grants were revoked; naming an address without
    /// a factor is an error that lists the enrolled addresses and leaves state
    /// unchanged.
    pub fn remove_factor(
        state_dir: &std::path::Path,
        choose: impl FnOnce(&StoredFactors) -> Result<Option<FactorTarget>>,
    ) -> Result<Option<FactorRemoval>> {
        Self::remove_factor_at(state_dir, unix_now(), choose)
    }
    fn remove_factor_at(
        state_dir: &std::path::Path,
        now: u64,
        choose: impl FnOnce(&StoredFactors) -> Result<Option<FactorTarget>>,
    ) -> Result<Option<FactorRemoval>> {
        let mut removed = Vec::new();
        let mut revoked_grants = 0;
        let mut chosen = false;
        recover(state_dir, |stored| {
            let choices = StoredFactors {
                factors: stored
                    .factors
                    .iter()
                    .map(|(address, factor)| StoredFactor {
                        address: address.clone(),
                        passkey: factor.kind() == FactorKind::Passkey,
                    })
                    .collect(),
                apps_with_access: stored
                    .grants
                    .iter()
                    .filter(|grant| !grant.revoked && grant.expires > now)
                    .count(),
            };
            let Some(target) = choose(&choices)? else {
                return Ok(false);
            };
            chosen = true;
            match target {
                FactorTarget::All => {
                    removed = std::mem::take(&mut stored.factors).into_keys().collect();
                }
                FactorTarget::Address(address) => {
                    let origin = factor_address(&address).ok_or_else(|| {
                        anyhow!("{address} is not an address such as https://agent.example.com")
                    })?;
                    if stored.factors.remove(&origin).is_none() {
                        let enrolled = stored.factors.keys().cloned().collect::<Vec<_>>();
                        bail!(
                            "no passkey or authenticator is set up for {origin}; set up: {}",
                            if enrolled.is_empty() {
                                "none".to_string()
                            } else {
                                enrolled.join(", ")
                            }
                        );
                    }
                    removed.push(origin);
                }
            }
            revoked_grants = revoke_all_grants(&mut stored.grants, now);
            Ok(!removed.is_empty() || revoked_grants > 0)
        })?;
        Ok(chosen.then_some(FactorRemoval {
            removed,
            revoked_grants,
        }))
    }

    /// Owner-run recovery only: replace the passphrase hash, keep passkeys and
    /// authenticators, and revoke every app grant.
    pub fn reset_passphrase(state_dir: &std::path::Path, passphrase: &str) -> Result<()> {
        let hash = hash_passphrase(passphrase)?;
        let now = unix_now();
        recover(state_dir, |stored| {
            stored.password_hash = hash;
            revoke_all_grants(&mut stored.grants, now);
            Ok(true)
        })?;
        Ok(())
    }

    fn grant_profile(&self, grant: &Grant) -> PermissionProfile {
        grant.profile.unwrap_or(self.config.default_profile)
    }
    fn profile_fingerprint(&self, profile: PermissionProfile) -> String {
        if profile == self.config.default_profile {
            self.config.policy_fingerprint.clone()
        } else {
            hash(&format!(
                "{}:{}",
                self.config.policy_fingerprint,
                profile.as_str()
            ))
        }
    }
    fn grant_active(&self, grant: &Grant, now: u64) -> bool {
        active(
            grant,
            now,
            &self.profile_fingerprint(self.grant_profile(grant)),
        )
    }

    pub fn router(self: Arc<Self>) -> Router {
        let mut router = Router::new();
        for path in [
            OWNER,
            LOGIN,
            "/agent-connect/owner/logout",
            pages::SECURITY,
            pages::GATEWAY,
            "/agent-connect/owner/grants/revoke-all",
            "/agent-connect/owner/sessions/end",
            "/agent-connect/owner/grants/revoke",
            pages::SETUP,
            pages::TOTP,
            ENROLL_TOTP,
            ENROLL_PASSKEY,
            REMOVE_FACTOR,
            PAR,
            AUTHORIZE,
            TOKEN,
            REVOKE,
            "/.well-known/oauth-authorization-server/agent-connect",
            "/.well-known/oauth-protected-resource/acp",
        ] {
            router = router.route(path, any(endpoint));
        }
        router.with_state(self)
    }

    /// Authenticate a canonical-entry-point bearer. Transports must use authenticate_at.
    pub fn authenticate(&self, token: &str, origin: &str) -> Result<AuthorizedGrant> {
        self.authenticate_at(token, origin, &self.config.public_url)
    }

    pub fn authenticate_at(
        &self,
        token: &str,
        origin: &str,
        issuer: &str,
    ) -> Result<AuthorizedGrant> {
        canonical_origin(origin)?;
        ensure!(
            issuer == self.config.public_url
                || self.config.entry_points.iter().any(|entry| entry == issuer),
            "invalid target"
        );
        ensure!(
            token.len() <= 256 && token.starts_with("ac_access_"),
            "invalid bearer"
        );
        let inner = self
            .inner
            .lock()
            .map_err(|_| anyhow!("authorization unavailable"))?;
        ensure!(!inner.broken, "authorization unavailable");
        let hashed = hash(token);
        let grant = inner
            .stored
            .grants
            .iter()
            .find(|g| {
                self.grant_issuer(g) == issuer
                    && g.client == origin
                    && g.access_hash.as_deref().is_some_and(|h| equal(h, &hashed))
            })
            .ok_or_else(|| anyhow!("invalid bearer"))?;
        ensure!(
            self.grant_active(grant, self.now()) && grant.access_expires > self.now(),
            "grant inactive"
        );
        Ok(AuthorizedGrant {
            id: grant.id.clone(),
            issuer: self.grant_issuer(grant).to_string(),
            permissions: self.grant_profile(grant),
            snapshot: snapshot(&grant.tools),
            tool_definitions: tool_definitions(&grant.tools),
            access_expires_at: grant.access_expires,
            epoch: grant.epoch.clone(),
            access_hash: hashed,
        })
    }

    pub fn recheck(&self, principal: &AuthorizedGrant) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        !inner.broken
            && inner.stored.grants.iter().any(|g| {
                g.id == principal.id
                    && g.epoch == principal.epoch
                    && self.grant_issuer(g) == principal.issuer
                    && self.grant_profile(g) == principal.permissions
                    && self.grant_active(g, self.now())
                    && g.access_expires > self.now()
                    && g.access_expires == principal.access_expires_at
                    && g.access_hash.as_deref() == Some(&principal.access_hash)
                    && snapshot(&g.tools) == principal.snapshot
                    && tool_definitions(&g.tools) == principal.tool_definitions
            })
    }

    /// Detached session hosts retain grant authority while access tokens rotate.
    pub fn is_grant_active(&self, id: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        !inner.broken
            && inner
                .stored
                .grants
                .iter()
                .any(|grant| grant.id == id && self.grant_active(grant, self.now()))
    }

    fn now(&self) -> u64 {
        #[cfg(test)]
        {
            self.clock.load(std::sync::atomic::Ordering::Relaxed)
        }
        #[cfg(not(test))]
        {
            unix_now()
        }
    }

    fn commit(&self, inner: &mut Inner, next: Stored) -> Result<()> {
        if inner.broken {
            bail!("authorization unavailable");
        }
        if let Err(error) = save(&self.config.state_dir, &next) {
            inner.broken = true;
            return Err(error.context("authorization unavailable"));
        }
        inner.stored = next;
        Ok(())
    }

    fn dispatch(
        &self,
        method: Method,
        path: &str,
        query: &str,
        headers: &HeaderMap,
        body: &[u8],
        peer: Option<IpAddr>,
    ) -> Result<Response> {
        let partitioned = !self.config.client_address_policies.is_empty();
        // In opt-in mode, reject unknown/missing/ambiguous Host before allocating
        // budgets. Host only selects policy; transport peer authenticates ingress.
        let source = if partitioned {
            let origin = self.entry_point(headers)?;
            self.config
                .client_address_policies
                .source(&origin, headers, peer)
        } else {
            ClientSource::legacy(peer)
        };
        let runtime_view = if method == Method::GET && path == OWNER {
            self.runtime
                .lock()
                .map_err(|_| anyhow!("runtime unavailable"))?
                .clone()
                .map(|runtime| runtime.snapshot())
        } else {
            None
        };
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow!("authorization unavailable"))?;
        ensure!(!inner.broken, "authorization unavailable");
        let now = self.now();
        inner.pending.retain(|_, r| r.expires > now);
        inner.codes.retain(|_, r| r.expires > now);
        inner.sessions.retain(|_, r| r.expires > now);
        inner.anonymous.retain(|_, r| r.expires > now);
        inner.anonymous_csrf.retain(|_, r| r.expires > now);
        inner.csrf.retain(|_, r| r.expires > now);
        if partitioned
            && method == Method::GET
            && path == LOGIN
            && self.session_id(&inner, headers, false).is_err()
        {
            // Session admission refusals also leave the shared counter intact.
            ensure!(
                inner
                    .anonymous
                    .values()
                    .filter(|session| session.source.as_ref() == Some(&source))
                    .count()
                    < CLIENT_SIGN_IN_LIMIT,
                "slow_down"
            );
            ensure!(
                inner.anonymous.len() < MAX_TRANSIENT,
                "authorization_capacity"
            );
        }
        // A rejected client must not continue exhausting the shared budget.
        // Owner traffic retains its existing exemption and global accounting.
        if partitioned && self.session_id(&inner, headers, true).is_err() {
            // A rate limit, not a guess limit: every request counts.
            let counted = attempt_budget(
                &mut inner.request_budgets,
                &source,
                now,
                60,
                CLIENT_REQUEST_LIMIT,
                "slow_down",
                true,
            )?;
            spend(&mut inner.request_budgets, &counted, now);
        }
        if now.saturating_sub(inner.rate_window) >= 60 {
            inner.rate_window = now;
            inner.rate_count = 0;
        }
        inner.rate_count = inner.rate_count.saturating_add(1);
        if inner.rate_count > 600 && self.session_id(&inner, headers, true).is_err() {
            return Ok(if path.starts_with(OWNER) || path == AUTHORIZE {
                owner_error(StatusCode::TOO_MANY_REQUESTS, "slow_down", path, None)
            } else {
                json_response(StatusCode::TOO_MANY_REQUESTS, json!({"error":"slow_down"}))
            });
        }
        if method == Method::POST {
            ensure!(query.is_empty(), "invalid_request");
        }
        if method == Method::OPTIONS && [PAR, TOKEN, REVOKE].contains(&path) {
            canonical_origin(single_header(headers, "origin")?)?;
            return Ok(Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header("access-control-allow-methods", "POST, OPTIONS")
                .header("access-control-allow-headers", "content-type")
                .body(Body::empty())?);
        }
        if method == Method::GET && path.starts_with("/.well-known/") {
            ensure!(query.is_empty(), "invalid_request");
            let origin = self.request_origin(headers)?;
            return Ok(json_response(
                StatusCode::OK,
                if path.contains("authorization-server") {
                    json!({"issuer":origin,"authorization_endpoint":format!("{origin}{AUTHORIZE}"),"token_endpoint":format!("{origin}{TOKEN}"),"revocation_endpoint":format!("{origin}{REVOKE}"),"pushed_authorization_request_endpoint":format!("{origin}{PAR}"),"require_pushed_authorization_requests":true,"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"scopes_supported":["acp"],"authorization_details_types_supported":["agent_connect"]})
                } else {
                    json!({"resource":format!("{origin}/acp"),"authorization_servers":[origin],"scopes_supported":["acp"],"bearer_methods_supported":["header"]})
                },
            ));
        }
        if method == Method::GET && path == LOGIN {
            let args = fields(query.as_bytes(), &["client_id", "request_uri"])?;
            let origin = self.request_origin(headers)?;
            let continuation = self.continuation(&inner, &args, &origin)?;
            let (session, cookie) = self.session(&mut inner, headers, false, &source)?;
            let purpose = format!("login:{continuation}");
            let csrf = csrf(&mut inner, &session, &purpose, now);
            let waiting = args
                .get("request_uri")
                .and_then(|uri| inner.pending.get(uri))
                .map(|pending| pending.client_name.clone());
            let method = match self.factor(&inner, &origin) {
                None => pages::SignIn::Setup,
                Some(Factor::Totp { .. }) => pages::SignIn::Totp,
                Some(Factor::Passkey { .. }) => pages::SignIn::Passkey(
                    self.begin_assertion(&mut inner, &session, &origin, &purpose)?,
                ),
            };
            let page = pages::sign_in(
                &(hidden("csrf_token", &csrf) + &hidden("continue", &continuation)),
                method,
                waiting.as_deref(),
            );
            return Ok(self.with_cookie(html(page), cookie, &origin));
        }
        if method == Method::POST && path == LOGIN {
            self.owner_origin(headers)?;
            let form = form(
                headers,
                body,
                &["csrf_token", "continue", "passphrase", "totp", "credential"],
            )?;
            let session = self.session_id(&inner, headers, false)?;
            let origin = self.request_origin(headers)?;
            let continuation = form.get("continue").cloned().unwrap_or_default();
            let purpose = format!("login:{continuation}");
            // Continuation is authenticated by the one-use CSRF binding and is never a caller URL.
            consume_csrf(
                &mut inner,
                &session,
                &format!("login:{continuation}"),
                required(&form, "csrf_token")?,
                now,
            )?;
            // Rebuild the route from live server state, never from an arbitrary
            // posted URL. The original one-use CSRF remains consumed on failure.
            let continuation = if continuation.is_empty() {
                continuation
            } else {
                let query = continuation
                    .strip_prefix(&format!("{AUTHORIZE}?"))
                    .ok_or_else(|| anyhow!("invalid_request"))?;
                let args = fields(query.as_bytes(), &["client_id", "request_uri"])?;
                ensure!(args.len() == 2, "invalid_request");
                self.continuation(&inner, &args, &self.request_origin(headers)?)?
            };
            let retry = match continuation.split_once('?') {
                Some((_, query)) => format!("{LOGIN}?{query}"),
                None => LOGIN.to_string(),
            };
            let factor = self.factor(&inner, &origin).map(|factor| factor.kind());
            let verification: Result<Authority> = (|| {
                let login_source = attempt_budget(
                    &mut inner.login_budgets,
                    &source,
                    now,
                    900,
                    10,
                    "login_rate_limited",
                    partitioned,
                )?;
                // A passkey stands alone; TOTP and setup start from the passphrase.
                if factor != Some(FactorKind::Passkey) {
                    let passphrase = required(&form, "passphrase")?;
                    let accepted = passphrase.len() <= 1024
                        && PasswordHash::new(&inner.stored.password_hash).is_ok_and(|parsed| {
                            Argon2::default()
                                .verify_password(passphrase.as_bytes(), &parsed)
                                .is_ok()
                        });
                    spend_on_wrong_guess(
                        &mut inner.login_budgets,
                        &login_source,
                        now,
                        if accepted {
                            Ok(())
                        } else {
                            Err(anyhow!("invalid_passphrase"))
                        },
                    )?;
                }
                match factor {
                    None => Ok(Authority::Setup),
                    Some(kind) => {
                        self.verify_factor(
                            &mut inner, &session, &origin, &purpose, &form, &source,
                        )?;
                        Ok(Authority::Owner(kind))
                    }
                }
            })();
            let authority = verification.map_err(|reason| SignInRetry {
                reason,
                target: retry,
            })?;
            inner.sessions.remove(&session);
            inner.anonymous.remove(&session);
            ensure!(
                inner.sessions.len() < MAX_TRANSIENT,
                "authorization_capacity"
            );
            let token = random("owner_");
            let (fresh, target) = if authority == Authority::Setup {
                let mut fresh = Session::new(origin.clone(), authority, now + SETUP_TTL);
                fresh.continuation = continuation;
                (fresh, pages::SETUP.to_string())
            } else {
                let target = if continuation.is_empty() {
                    OWNER.to_string()
                } else {
                    continuation
                };
                (
                    Session::new(origin.clone(), authority, now + OWNER_TTL),
                    target,
                )
            };
            inner.sessions.insert(hash(&token), fresh);
            return Ok(self.with_cookie(redirect(&target)?, Some(token), &origin));
        }
        if method == Method::GET && (path == pages::SETUP || path == pages::TOTP) {
            let Ok(session) = self.session_id_for(&inner, headers, |a| a == Authority::Setup)
            else {
                return redirect(LOGIN);
            };
            ensure!(query.is_empty(), "invalid_request");
            let origin = self.request_origin(headers)?;
            ensure!(
                self.factor(&inner, &origin).is_none(),
                "factor_already_enrolled"
            );
            if path == pages::TOTP {
                let mut bytes = [0u8; 20];
                OsRng.fill_bytes(&mut bytes);
                let secret = base32(&bytes);
                inner.sessions.get_mut(&session).unwrap().enrollment = Some(Enrollment::Totp {
                    secret: secret.clone(),
                    expires: now + CEREMONY_TTL,
                });
                let token = csrf(&mut inner, &session, "factor_verify", now);
                let mut uri = Url::parse("otpauth://totp/Agent%20Connect:owner")?;
                uri.query_pairs_mut()
                    .append_pair("secret", &secret)
                    .append_pair("issuer", "Agent Connect")
                    .append_pair("algorithm", "SHA1")
                    .append_pair("digits", "6")
                    .append_pair("period", "30");
                return Ok(html(pages::totp_scan(
                    &secret,
                    uri.as_str(),
                    &hidden("csrf_token", &token),
                )));
            }
            let options = if passkey_possible(&origin) {
                let user = Uuid::new_v4();
                let host = Url::parse(&origin)?
                    .host_str()
                    .unwrap_or_default()
                    .to_string();
                let (options, state) = webauthn(&origin)?
                    .start_passkey_registration(user, &host, "Agent Connect owner", None)
                    .map_err(|_| anyhow!("passkey_unavailable"))?;
                inner.sessions.get_mut(&session).unwrap().enrollment = Some(Enrollment::Passkey {
                    user,
                    state,
                    expires: now + CEREMONY_TTL,
                });
                Some(serde_json::to_string(&options)?)
            } else {
                None
            };
            let token = csrf(&mut inner, &session, "enroll", now);
            return Ok(html(pages::setup(
                &hidden("csrf_token", &token),
                options.as_deref(),
            )));
        }
        if method == Method::GET && [OWNER, pages::SECURITY, pages::GATEWAY].contains(&path) {
            let Ok(session) = self.session_id(&inner, headers, true) else {
                if self
                    .session_id_for(&inner, headers, |a| a == Authority::Setup)
                    .is_ok()
                {
                    return redirect(pages::SETUP);
                }
                return redirect(LOGIN);
            };
            ensure!(query.is_empty(), "invalid_request");
            let logout_token = csrf(&mut inner, &session, "logout", now);
            let addresses = self.configured_addresses();
            if path == pages::SECURITY {
                let origin = self.request_origin(headers)?;
                let Some(Authority::Owner(signed_in)) =
                    inner.sessions.get(&session).map(|s| s.authority)
                else {
                    bail!("owner_login_required");
                };
                let proof =
                    match signed_in {
                        FactorKind::Passkey => pages::ApprovalFactor::Passkey(
                            self.begin_assertion(&mut inner, &session, &origin, "factor:remove")?,
                        ),
                        FactorKind::Totp => pages::ApprovalFactor::Totp,
                    };
                let mut rows = Vec::new();
                for address in addresses {
                    let kind = inner.stored.factors.get(&address).map(Factor::kind);
                    let remove_token = kind.filter(|kind| may_remove(signed_in, *kind)).map(|_| {
                        csrf(
                            &mut inner,
                            &session,
                            &format!("remove-factor:{address}"),
                            now,
                        )
                    });
                    rows.push(pages::AddressFactor {
                        current: address == origin,
                        passkey: kind.map(|kind| kind == FactorKind::Passkey),
                        remove_token,
                        address,
                    });
                }
                let active_grants = inner
                    .stored
                    .grants
                    .iter()
                    .filter(|g| self.grant_active(g, now))
                    .count();
                let revoke_all_token = csrf(&mut inner, &session, "revoke-all", now);
                return Ok(html(pages::security(pages::Security {
                    logout_token,
                    addresses: rows,
                    proof,
                    active_grants,
                    revoke_all_token,
                })));
            }
            if path == pages::GATEWAY {
                let harness = self.config.harness;
                return Ok(html(pages::gateway(pages::Gateway {
                    logout_token,
                    harness: match harness {
                        Harness::Codex => "Codex",
                        Harness::Claude => "Claude Code",
                    },
                    addresses,
                    profiles: self
                        .config
                        .profiles
                        .iter()
                        .map(|p| {
                            (
                                profile_label(*p),
                                profile_summary(*p),
                                profile_description(*p, harness),
                            )
                        })
                        .collect(),
                    profile_note: if harness == Harness::Codex {
                        "Deny-all and app-tools-only are not offered for Codex: inside its box, its own tools can act without asking for permission."
                    } else {
                        "Read-only is not offered for Claude Code. Its options govern permission requests; actions that do not ask for permission may still run."
                    },
                })));
            }
            // One activity view: a request made on another address is reviewed
            // there, where its consent and that address's factor apply.
            let here = self.request_origin(headers)?;
            let requests = inner
                .pending
                .iter()
                .map(|(uri, pending)| {
                    let elsewhere = (pending.issuer != here).then(|| pending.issuer.clone());
                    pages::Request {
                        name: pending.client_name.clone(),
                        origin: pending.client.clone(),
                        href: format!(
                            "{}{}",
                            elsewhere.as_deref().unwrap_or(""),
                            authorize_url(&pending.client, uri)
                        ),
                        address: elsewhere,
                        tools: pending.tools.len(),
                        expires: pending.expires,
                    }
                })
                .collect();
            let grants = inner.stored.grants.clone();
            let live = runtime_view.as_ref().map(|view| {
                view.sessions
                    .iter()
                    .map(|live| pages::Live {
                        name: grants
                            .iter()
                            .find(|grant| grant.id == live.grant_id)
                            .and_then(|grant| grant.name.clone()),
                        origin: grants
                            .iter()
                            .find(|grant| grant.id == live.grant_id)
                            .map(|grant| grant.client.clone())
                            .unwrap_or_else(|| "Application unavailable".into()),
                        id: live.id.clone(),
                        state: live.state.clone(),
                        started: live.started_at,
                        end_token: csrf(&mut inner, &session, &format!("end:{}", live.id), now),
                    })
                    .collect()
            });
            let mut events = Vec::new();
            for grant in &grants {
                let state = if self.grant_active(grant, now) {
                    pages::GrantState::Active {
                        grant_id: grant.id.clone(),
                        revoke_token: csrf(
                            &mut inner,
                            &session,
                            &format!("revoke:{}", grant.id),
                            now,
                        ),
                    }
                } else if !grant.revoked && grant.expires > now {
                    pages::GrantState::Paused
                } else {
                    pages::GrantState::Ended
                };
                events.push(pages::Event {
                    name: grant.name.clone(),
                    at: grant.approved_at,
                    origin: grant.client.clone(),
                    kind: pages::EventKind::Approved {
                        profile: profile_label(self.grant_profile(grant)),
                        tools: grant.tools.clone(),
                        expires: grant.expires,
                        lifetime: grant.approved_at.map(|at| grant.expires.saturating_sub(at)),
                        state,
                    },
                });
                if grant.revoked {
                    events.push(pages::Event {
                        name: grant.name.clone(),
                        at: grant.revoked_at,
                        origin: grant.client.clone(),
                        kind: pages::EventKind::Revoked,
                    });
                } else if grant.expires <= now {
                    events.push(pages::Event {
                        name: grant.name.clone(),
                        at: Some(grant.expires),
                        origin: grant.client.clone(),
                        kind: pages::EventKind::Expired,
                    });
                }
            }
            return Ok(html(pages::console(pages::Console {
                now,
                logout_token,
                sign_in_failures: self
                    .sign_in_audit
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .recent(now),
                sign_in_pauses: sign_in_audit::pauses(&inner, now),
                problems: runtime_view
                    .as_ref()
                    .map(|view| {
                        view.problems
                            .iter()
                            .map(|problem| (problem.message.clone(), problem.repair.clone()))
                            .collect()
                    })
                    .unwrap_or_default(),
                requests,
                live,
                events,
                addresses,
            })));
        }
        if method == Method::POST && path == "/agent-connect/owner/sessions/end" {
            self.owner_origin(headers)?;
            let session = self.session_id(&inner, headers, true)?;
            let form = form(headers, body, &["csrf_token", "session_id"])?;
            let id = required(&form, "session_id")?;
            bounded(id, 256)?;
            consume_csrf(
                &mut inner,
                &session,
                &format!("end:{id}"),
                required(&form, "csrf_token")?,
                now,
            )?;
            drop(inner);
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| anyhow!("runtime unavailable"))?
                .clone()
                .ok_or_else(|| anyhow!("runtime unavailable"))?;
            runtime.end_session(id)?;
            return redirect(OWNER);
        }
        if method == Method::POST && path.starts_with("/agent-connect/owner/") {
            return self.owner_post(&mut inner, path, headers, body, &source);
        }
        if method == Method::POST && path == PAR {
            let form = form(
                headers,
                body,
                &[
                    "client_id",
                    "client_name",
                    "redirect_uri",
                    "resource",
                    "response_type",
                    "scope",
                    "state",
                    "code_challenge",
                    "code_challenge_method",
                    "authorization_details",
                ],
            )?;
            let client = required(&form, "client_id")?;
            self.app_origin(headers, client)?;
            let redirect = required(&form, "redirect_uri")?;
            valid_redirect(redirect, client)?;
            let issuer = self.request_origin(headers)?;
            ensure!(
                required(&form, "resource")? == format!("{issuer}/acp"),
                "invalid_target"
            );
            ensure!(
                required(&form, "response_type")? == "code" && required(&form, "scope")? == "acp",
                "invalid_request"
            );
            ensure!(
                required(&form, "code_challenge_method")? == "S256",
                "invalid_request"
            );
            let challenge = required(&form, "code_challenge")?;
            ensure!(
                challenge.len() == 43
                    && challenge
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
                "invalid_request"
            );
            let state = required(&form, "state")?;
            bounded(state, 512)?;
            let details: Value = serde_json::from_str(required(&form, "authorization_details")?)?;
            let array = details
                .as_array()
                .ok_or_else(|| anyhow!("invalid_authorization_details"))?;
            ensure!(array.len() == 1, "invalid_authorization_details");
            let detail = array[0]
                .as_object()
                .ok_or_else(|| anyhow!("invalid_authorization_details"))?;
            ensure!(
                detail.len() == 2 && detail.get("type") == Some(&json!("agent_connect")),
                "invalid_authorization_details"
            );
            let tools = validate_tools(
                detail
                    .get("tools")
                    .ok_or_else(|| anyhow!("invalid_authorization_details"))?,
            )?;
            ensure!(
                inner.pending.len() < MAX_TRANSIENT,
                "authorization_capacity"
            );
            let name = form
                .get("client_name")
                .cloned()
                .unwrap_or_else(|| client.to_string());
            bounded(&name, 200)?;
            let uri = random("urn:ietf:params:oauth:request_uri:ac_request_");
            inner.pending.insert(
                uri.clone(),
                Pending {
                    issuer,
                    client: client.to_string(),
                    client_name: name,
                    redirect: redirect.to_string(),
                    state: state.to_string(),
                    challenge: challenge.to_string(),
                    tools,
                    expires: now + REQUEST_TTL,
                },
            );
            return Ok(json_response(
                StatusCode::CREATED,
                json!({"request_uri":uri,"expires_in":REQUEST_TTL}),
            ));
        }
        if path == AUTHORIZE && method == Method::GET {
            let args = fields(query.as_bytes(), &["client_id", "request_uri"])?;
            let uri = required(&args, "request_uri")?;
            let pending = inner
                .pending
                .get(uri)
                .filter(|p| Some(&p.client) == args.get("client_id"))
                .cloned()
                .ok_or_else(|| anyhow!("invalid_request"))?;
            ensure!(
                pending.issuer == self.request_origin(headers)?,
                "invalid_target"
            );
            let session = match self.session_id(&inner, headers, true) {
                Ok(session) => session,
                Err(_) => {
                    let mut url = Url::parse(&format!("{}{LOGIN}", self.config.public_url))?;
                    url.query_pairs_mut()
                        .append_pair("client_id", &pending.client)
                        .append_pair("request_uri", uri);
                    return redirect(&format!("{LOGIN}?{}", url.query().unwrap_or("")));
                }
            };
            let purpose = format!("consent:{uri}");
            let token = csrf(&mut inner, &session, &purpose, now);
            let origin = self.request_origin(headers)?;
            let factor = match self.factor(&inner, &origin) {
                Some(Factor::Passkey { .. }) => pages::ApprovalFactor::Passkey(
                    self.begin_assertion(&mut inner, &session, &origin, &purpose)?,
                ),
                Some(Factor::Totp { .. }) => pages::ApprovalFactor::Totp,
                None => bail!("owner_login_required"),
            };
            let harness = self.config.harness;
            let page = pages::consent(pages::Consent {
                name: pending.client_name.clone(),
                origin: pending.client.clone(),
                tools: pending.tools.clone(),
                fields: hidden("request_uri", uri) + &hidden("csrf_token", &token),
                profiles: self
                    .config
                    .profiles
                    .iter()
                    .map(|profile| pages::ProfileChoice {
                        value: profile.as_str(),
                        label: profile_label(*profile),
                        summary: profile_summary(*profile),
                        detail: profile_description(*profile, harness),
                        selected: *profile == self.config.default_profile,
                    })
                    .collect(),
                factor,
            });
            // The callback leaves through the form, so the application origin
            // joins form-action; the page's own script and styles stay pinned.
            return Ok(html_for(page, Some(&pending.client)));
        }
        if path == AUTHORIZE && method == Method::POST {
            self.owner_origin(headers)?;
            let form = form(
                headers,
                body,
                &[
                    "request_uri",
                    "csrf_token",
                    "decision",
                    "duration",
                    "totp",
                    "credential",
                    "profile",
                ],
            )?;
            let session = self.session_id(&inner, headers, true)?;
            let uri = required(&form, "request_uri")?;
            consume_csrf(
                &mut inner,
                &session,
                &format!("consent:{uri}"),
                required(&form, "csrf_token")?,
                now,
            )?;
            let pending = inner
                .pending
                .get(uri)
                .cloned()
                .ok_or_else(|| anyhow!("invalid_request"))?;
            ensure!(
                pending.issuer == self.request_origin(headers)?,
                "invalid_target"
            );
            let decision = required(&form, "decision")?;
            ensure!(["approve", "deny"].contains(&decision), "invalid_request");
            if decision == "deny" {
                inner.pending.remove(uri);
                return self.callback(&pending, "error", "access_denied");
            }
            let profile = if let Some(value) = form.get("profile") {
                self.config
                    .profiles
                    .iter()
                    .copied()
                    .find(|profile| profile.as_str() == value)
                    .ok_or_else(|| anyhow!("invalid_profile"))?
            } else if self.config.profiles.len() == 1 {
                self.config.default_profile
            } else {
                bail!("invalid_profile")
            };
            let origin = self.request_origin(headers)?;
            self.verify_factor(
                &mut inner,
                &session,
                &origin,
                &format!("consent:{uri}"),
                &form,
                &source,
            )?;
            let duration: u64 = required(&form, "duration")?.parse()?;
            ensure!((60..=MAX_DURATION).contains(&duration), "invalid_request");
            ensure!(inner.codes.len() < MAX_TRANSIENT, "authorization_capacity");
            let mut next = inner.stored.clone();
            next.grants.retain(|g| !g.revoked && g.expires > now);
            ensure!(next.grants.len() < MAX_GRANTS, "grant_capacity");
            let id = random("ac_grant_");
            next.grants.push(Grant {
                id: id.clone(),
                epoch: random("epoch_"),
                client: pending.client.clone(),
                fingerprint: self.profile_fingerprint(profile),
                profile: Some(profile),
                issuer: Some(pending.issuer.clone()),
                tools: pending.tools.clone(),
                expires: now + duration,
                revoked: false,
                approved_at: Some(now),
                revoked_at: None,
                name: Some(pending.client_name.clone()),
                access_hash: None,
                access_expires: 0,
                refresh_hash: None,
                spent: Vec::new(),
            });
            self.commit(&mut inner, next)?;
            let code = random("ac_code_");
            inner.pending.remove(uri);
            inner.codes.insert(
                hash(&code),
                Code {
                    request: pending.clone(),
                    grant: id,
                    expires: now + CODE_TTL,
                },
            );
            return self.callback(&pending, "code", &code);
        }
        if path == TOKEN && method == Method::POST {
            let form = form(
                headers,
                body,
                &[
                    "grant_type",
                    "code",
                    "code_verifier",
                    "client_id",
                    "redirect_uri",
                    "resource",
                    "refresh_token",
                ],
            )?;
            let client = required(&form, "client_id")?;
            self.app_origin(headers, client)?;
            let issuer = self.request_origin(headers)?;
            ensure!(
                required(&form, "resource")? == format!("{issuer}/acp"),
                "invalid_target"
            );
            let grant_id = match required(&form, "grant_type")? {
                "authorization_code" => {
                    ensure!(!form.contains_key("refresh_token"), "invalid_request");
                    let code = hash(required(&form, "code")?);
                    let record = inner
                        .codes
                        .get(&code)
                        .cloned()
                        .ok_or_else(|| anyhow!("invalid_grant"))?;
                    let verifier = required(&form, "code_verifier")?;
                    ensure!(
                        record.request.issuer == issuer
                            && record.request.client == client
                            && record.request.redirect == required(&form, "redirect_uri")?
                            && pkce_verifier(verifier)
                            && equal(&hash(verifier), &record.request.challenge),
                        "invalid_grant"
                    );
                    // An incorrect verifier cannot consume another client's valid code.
                    let response = self.issue(&mut inner, &record.grant)?;
                    inner.codes.remove(&code);
                    return Ok(response);
                }
                "refresh_token" => {
                    ensure!(
                        !["code", "code_verifier", "redirect_uri"]
                            .iter()
                            .any(|key| form.contains_key(*key)),
                        "invalid_request"
                    );
                    let hashed = hash(required(&form, "refresh_token")?);
                    if let Some(grant) = inner
                        .stored
                        .grants
                        .iter()
                        .find(|g| {
                            self.grant_issuer(g) == issuer
                                && g.client == client
                                && g.spent.iter().any(|h| equal(h, &hashed))
                        })
                        .cloned()
                    {
                        if !grant.revoked {
                            self.revoke_id(&mut inner, &grant.id)?;
                        }
                        bail!("invalid_grant");
                    }
                    inner
                        .stored
                        .grants
                        .iter()
                        .find(|g| {
                            self.grant_issuer(g) == issuer
                                && g.client == client
                                && g.refresh_hash.as_deref().is_some_and(|h| equal(h, &hashed))
                        })
                        .map(|g| g.id.clone())
                        .ok_or_else(|| anyhow!("invalid_grant"))?
                }
                _ => bail!("unsupported_grant_type"),
            };
            return self.issue(&mut inner, &grant_id);
        }
        if path == REVOKE && method == Method::POST {
            let form = form(headers, body, &["token", "client_id"])?;
            let client = required(&form, "client_id")?;
            self.app_origin(headers, client)?;
            let hashed = hash(required(&form, "token")?);
            let issuer = self.request_origin(headers)?;
            let id = inner
                .stored
                .grants
                .iter()
                .find(|g| {
                    self.grant_issuer(g) == issuer
                        && g.client == client
                        && (g.access_hash.as_deref() == Some(&hashed)
                            || g.refresh_hash.as_deref() == Some(&hashed)
                            || g.spent.contains(&hashed))
                })
                .map(|g| g.id.clone());
            if let Some(id) = id {
                self.revoke_id(&mut inner, &id)?;
            }
            return Ok(json_response(StatusCode::OK, json!({})));
        }
        Ok(json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error":"invalid_request"}),
        ))
    }

    fn issue(&self, inner: &mut Inner, id: &str) -> Result<Response> {
        let mut next = inner.stored.clone();
        let grant = next
            .grants
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| anyhow!("invalid_grant"))?;
        ensure!(self.grant_active(grant, self.now()), "invalid_grant");
        // At the history bound fail closed rather than forget a replayable token.
        ensure!(grant.spent.len() < MAX_SPENT_REFRESH, "invalid_grant");
        let access = random("ac_access_");
        let refresh = random("ac_refresh_");
        if let Some(old) = grant.refresh_hash.take() {
            grant.spent.push(old);
        }
        grant.access_hash = Some(hash(&access));
        grant.refresh_hash = Some(hash(&refresh));
        grant.access_expires = grant.expires.min(self.now() + ACCESS_TTL);
        let response = json_response(
            StatusCode::OK,
            json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer","expires_in":grant.access_expires-self.now(),"refresh_token_expires_in":grant.expires-self.now(),"grant_id":grant.id,"gateway_url":format!("{}/acp",self.grant_issuer(grant).replacen("https:","wss:",1).replacen("http:","ws:",1))}),
        );
        self.commit(inner, next)?;
        Ok(response)
    }

    fn revoke_id(&self, inner: &mut Inner, id: &str) -> Result<()> {
        let mut next = inner.stored.clone();
        let grant = next
            .grants
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| anyhow!("invalid_grant"))?;
        revoke_grant(grant, self.now());
        self.commit(inner, next)?;
        inner.codes.retain(|_, code| code.grant != id);
        Ok(())
    }

    fn factor(&self, inner: &Inner, origin: &str) -> Option<Factor> {
        inner.stored.factors.get(origin).cloned()
    }
    /// Fresh proof of the address's factor: a passkey assertion for `purpose`,
    /// or a TOTP code. An address without a factor proves nothing.
    fn verify_factor(
        &self,
        inner: &mut Inner,
        session: &str,
        origin: &str,
        purpose: &str,
        form: &BTreeMap<String, String>,
        source: &ClientSource,
    ) -> Result<()> {
        let counted = self.factor_budget(inner, source)?;
        match self.factor(inner, origin) {
            Some(Factor::Passkey { .. }) => {
                let verified = self.finish_assertion(
                    inner,
                    session,
                    origin,
                    purpose,
                    form.get("credential").map(String::as_str).unwrap_or(""),
                );
                spend_on_wrong_guess(&mut inner.factor_budgets, &counted, self.now(), verified)
            }
            Some(Factor::Totp { secret, last_step }) => {
                let code = form.get("totp").map(String::as_str).unwrap_or("");
                let step = spend_on_wrong_guess(
                    &mut inner.factor_budgets,
                    &counted,
                    self.now(),
                    verify_totp(&secret, code, self.now(), last_step),
                )?;
                let mut next = inner.stored.clone();
                next.factors.insert(
                    origin.to_string(),
                    Factor::Totp {
                        secret,
                        last_step: Some(step),
                    },
                );
                self.commit(inner, next)
            }
            None => bail!("owner_login_required"),
        }
    }
    /// Start a passkey assertion bound to this session, origin and purpose; the
    /// options go to the page. A newer one for the same purpose replaces it.
    fn begin_assertion(
        &self,
        inner: &mut Inner,
        session: &str,
        origin: &str,
        purpose: &str,
    ) -> Result<String> {
        let Some(Factor::Passkey { passkey, .. }) = self.factor(inner, origin) else {
            bail!("invalid_request");
        };
        let (options, state) = webauthn(origin)?
            .start_passkey_authentication(&[*passkey])
            .map_err(|_| anyhow!("passkey_unavailable"))?;
        let now = self.now();
        let session = session_mut(inner, session).ok_or_else(|| anyhow!("invalid_session"))?;
        session.ceremonies.retain(|_, (_, expires)| *expires > now);
        ensure!(
            session.ceremonies.len() < MAX_CEREMONIES || session.ceremonies.contains_key(purpose),
            "authorization_capacity"
        );
        session
            .ceremonies
            .insert(purpose.to_string(), (state, now + CEREMONY_TTL));
        Ok(serde_json::to_string(&options)?)
    }
    /// Verify a passkey assertion. The matching challenge is consumed whether or
    /// not the assertion verifies.
    fn finish_assertion(
        &self,
        inner: &mut Inner,
        session: &str,
        origin: &str,
        purpose: &str,
        credential: &str,
    ) -> Result<()> {
        let now = self.now();
        let (state, expires) = session_mut(inner, session)
            .and_then(|session| session.ceremonies.remove(purpose))
            .ok_or_else(|| anyhow!("invalid_passkey"))?;
        ensure!(expires > now, "invalid_passkey");
        ensure!(
            !credential.is_empty() && credential.len() <= MAX_CREDENTIAL,
            "invalid_passkey"
        );
        let credential: PublicKeyCredential =
            serde_json::from_str(credential).map_err(|_| anyhow!("invalid_passkey"))?;
        let result = webauthn(origin)?
            .finish_passkey_authentication(&credential, &state)
            .map_err(|_| anyhow!("invalid_passkey"))?;
        ensure!(result.user_verified(), "invalid_passkey");
        let mut next = inner.stored.clone();
        if let Some(Factor::Passkey { passkey, .. }) = next.factors.get_mut(origin)
            && passkey.update_credential(&result) == Some(true)
        {
            self.commit(inner, next)?;
        }
        Ok(())
    }
    /// Commit a factor for this unenrolled address and turn the setup session
    /// into a full owner session on a fresh cookie.
    fn enroll(
        &self,
        inner: &mut Inner,
        session: &str,
        origin: &str,
        factor: Factor,
    ) -> Result<Response> {
        ensure!(
            self.factor(inner, origin).is_none(),
            "factor_already_enrolled"
        );
        let kind = factor.kind();
        let mut next = inner.stored.clone();
        next.factors.insert(origin.to_string(), factor);
        self.commit(inner, next)?;
        let continuation = inner
            .sessions
            .remove(session)
            .map(|session| session.continuation)
            .unwrap_or_default();
        inner.csrf.retain(|_, token| token.session != session);
        let token = random("owner_");
        inner.sessions.insert(
            hash(&token),
            Session::new(
                origin.to_string(),
                Authority::Owner(kind),
                self.now() + OWNER_TTL,
            ),
        );
        let target = if continuation.is_empty() {
            OWNER.to_string()
        } else {
            continuation
        };
        Ok(self.with_cookie(redirect(&target)?, Some(token), origin))
    }
    fn factor_budget(&self, inner: &mut Inner, source: &ClientSource) -> Result<ClientSource> {
        attempt_budget(
            &mut inner.factor_budgets,
            source,
            self.now(),
            60,
            5,
            "factor_rate_limited",
            !self.config.client_address_policies.is_empty(),
        )
    }
    fn owner_post(
        &self,
        inner: &mut Inner,
        path: &str,
        headers: &HeaderMap,
        body: &[u8],
        source: &ClientSource,
    ) -> Result<Response> {
        self.owner_origin(headers)?;
        let now = self.now();
        if [ENROLL_TOTP, ENROLL_PASSKEY].contains(&path) {
            let session = self.session_id_for(inner, headers, |a| a == Authority::Setup)?;
            let origin = self.request_origin(headers)?;
            let fields: &[&str] = if path == ENROLL_TOTP {
                &["csrf_token", "totp"]
            } else {
                &["csrf_token", "credential"]
            };
            let form = form(headers, body, fields)?;
            consume_csrf(
                inner,
                &session,
                if path == ENROLL_TOTP {
                    "factor_verify"
                } else {
                    "enroll"
                },
                required(&form, "csrf_token")?,
                now,
            )?;
            ensure!(
                self.factor(inner, &origin).is_none(),
                "factor_already_enrolled"
            );
            let counted = self.factor_budget(inner, source)?;
            let enrollment = inner
                .sessions
                .get_mut(&session)
                .and_then(|session| session.enrollment.take())
                .ok_or_else(|| anyhow!("invalid_enrollment"))?;
            let factor = match (path, enrollment) {
                (ENROLL_TOTP, Enrollment::Totp { secret, expires }) => {
                    ensure!(expires > now, "invalid_enrollment");
                    let code = required(&form, "totp")?;
                    let step = spend_on_wrong_guess(
                        &mut inner.factor_budgets,
                        &counted,
                        now,
                        verify_totp(&secret, code, now, None),
                    )?;
                    Factor::Totp {
                        secret,
                        last_step: Some(step),
                    }
                }
                (
                    ENROLL_PASSKEY,
                    Enrollment::Passkey {
                        user,
                        state,
                        expires,
                    },
                ) => {
                    ensure!(expires > now, "invalid_enrollment");
                    let credential = required(&form, "credential")?;
                    let registered = (|| {
                        ensure!(credential.len() <= MAX_CREDENTIAL, "invalid_passkey");
                        let credential: RegisterPublicKeyCredential =
                            serde_json::from_str(credential)
                                .map_err(|_| anyhow!("invalid_passkey"))?;
                        webauthn(&origin)?
                            .finish_passkey_registration(&credential, &state)
                            .map_err(|_| anyhow!("invalid_passkey"))
                    })();
                    let passkey =
                        spend_on_wrong_guess(&mut inner.factor_budgets, &counted, now, registered)?;
                    Factor::Passkey {
                        user,
                        passkey: Box::new(passkey),
                    }
                }
                _ => bail!("invalid_enrollment"),
            };
            return self.enroll(inner, &session, &origin, factor);
        }
        let session = self.session_id(inner, headers, true)?;
        match path {
            "/agent-connect/owner/logout" => {
                let form = form(headers, body, &["csrf_token"])?;
                consume_csrf(
                    inner,
                    &session,
                    "logout",
                    required(&form, "csrf_token")?,
                    now,
                )?;
                inner.sessions.remove(&session);
                inner.csrf.retain(|_, token| token.session != session);
                let mut response = redirect(LOGIN)?;
                response.headers_mut().insert(
                    header::SET_COOKIE,
                    OwnerCookiePolicy::for_origin(&self.request_origin(headers)?).header("", 0),
                );
                Ok(response)
            }
            REMOVE_FACTOR => {
                let form = form(
                    headers,
                    body,
                    &["csrf_token", "address", "credential", "totp"],
                )?;
                let address = required(&form, "address")?.to_string();
                consume_csrf(
                    inner,
                    &session,
                    &format!("remove-factor:{address}"),
                    required(&form, "csrf_token")?,
                    now,
                )?;
                let Some(Authority::Owner(signed_in)) =
                    inner.sessions.get(&session).map(|s| s.authority)
                else {
                    bail!("owner_login_required");
                };
                ensure!(
                    self.configured_addresses().contains(&address),
                    "invalid_request"
                );
                let target = self
                    .factor(inner, &address)
                    .ok_or_else(|| anyhow!("invalid_request"))?;
                ensure!(may_remove(signed_in, target.kind()), "passkey_required");
                let origin = self.request_origin(headers)?;
                self.verify_factor(inner, &session, &origin, "factor:remove", &form, source)?;
                let mut next = inner.stored.clone();
                next.factors.remove(&address);
                let mut revoked_ids = std::collections::HashSet::new();
                for grant in &mut next.grants {
                    if self.grant_issuer(grant) == address {
                        revoke_grant(grant, now);
                        revoked_ids.insert(grant.id.clone());
                    }
                }
                self.commit(inner, next)?;
                inner.codes.retain(|_, code| {
                    code.request.issuer != address && !revoked_ids.contains(&code.grant)
                });
                // The address is back to setup: whoever was signed in there is out.
                let ended = inner
                    .sessions
                    .iter()
                    .filter(|(_, s)| s.origin == address)
                    .map(|(id, _)| id.clone())
                    .collect::<std::collections::HashSet<_>>();
                inner.sessions.retain(|id, _| !ended.contains(id));
                inner
                    .csrf
                    .retain(|_, token| !ended.contains(&token.session));
                if address != origin {
                    return redirect(pages::SECURITY);
                }
                let mut response = redirect(LOGIN)?;
                response.headers_mut().insert(
                    header::SET_COOKIE,
                    OwnerCookiePolicy::for_origin(&origin).header("", 0),
                );
                Ok(response)
            }
            "/agent-connect/owner/grants/revoke" => {
                let form = form(headers, body, &["csrf_token", "grant_id"])?;
                let id = required(&form, "grant_id")?;
                consume_csrf(
                    inner,
                    &session,
                    &format!("revoke:{id}"),
                    required(&form, "csrf_token")?,
                    now,
                )?;
                self.revoke_id(inner, id)?;
                redirect(OWNER)
            }
            "/agent-connect/owner/grants/revoke-all" => {
                let form = form(headers, body, &["csrf_token"])?;
                consume_csrf(
                    inner,
                    &session,
                    "revoke-all",
                    required(&form, "csrf_token")?,
                    now,
                )?;
                let mut next = inner.stored.clone();
                revoke_all_grants(&mut next.grants, now);
                self.commit(inner, next)?;
                inner.codes.clear();
                redirect(OWNER)
            }
            _ => bail!("invalid_request"),
        }
    }

    fn continuation(
        &self,
        inner: &Inner,
        args: &BTreeMap<String, String>,
        origin: &str,
    ) -> Result<String> {
        if args.is_empty() {
            return Ok(String::new());
        }
        let client = required(args, "client_id")?;
        let uri = required(args, "request_uri")?;
        ensure!(
            inner.pending.get(uri).is_some_and(|p| {
                p.client == client && p.issuer == origin && p.expires > self.now()
            }),
            "invalid_request"
        );
        Ok(authorize_url(client, uri))
    }
    fn callback(&self, pending: &Pending, key: &str, value: &str) -> Result<Response> {
        let mut url = Url::parse(&pending.redirect)?;
        // Do not allow app-supplied duplicate protocol response parameters.
        let query: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| !["code", "error", "state", "iss"].contains(&k.as_ref()))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        url.query_pairs_mut()
            .extend_pairs(query)
            .append_pair(key, value)
            .append_pair("state", &pending.state)
            .append_pair("iss", &pending.issuer);
        redirect(url.as_str())
    }
    fn owner_origin(&self, headers: &HeaderMap) -> Result<()> {
        ensure!(
            single_header(headers, "origin")? == self.request_origin(headers)?,
            "invalid_owner_origin"
        );
        Ok(())
    }
    fn request_origin(&self, headers: &HeaderMap) -> Result<String> {
        if !headers.contains_key(header::HOST) {
            // In-process contract fixtures have no HTTP transport/Host.
            return Ok(self.config.public_url.clone());
        }
        self.entry_point(headers)
    }

    /// Resolve the bearer audience from exactly one configured HTTP Host. Transport
    /// callers must use this strict helper; forwarded headers never select authority.
    pub fn entry_point(&self, headers: &HeaderMap) -> Result<String> {
        let hosts = headers.get_all(header::HOST).iter().collect::<Vec<_>>();
        ensure!(hosts.len() == 1, "invalid_target");
        let host = hosts[0].to_str()?;
        let origin = std::iter::once(&self.config.public_url)
            .chain(self.config.entry_points.iter())
            .find(|origin| {
                Url::parse(origin).is_ok_and(|url| {
                    &url[url::Position::BeforeHost..url::Position::AfterPort] == host
                })
            })
            .ok_or_else(|| anyhow!("invalid_target"))?;
        Ok(origin.clone())
    }
    fn configured_addresses(&self) -> Vec<String> {
        std::iter::once(&self.config.public_url)
            .chain(self.config.entry_points.iter())
            .cloned()
            .collect()
    }
    fn grant_issuer<'a>(&'a self, grant: &'a Grant) -> &'a str {
        grant.issuer.as_deref().unwrap_or(&self.config.public_url)
    }
    fn app_origin(&self, headers: &HeaderMap, client: &str) -> Result<()> {
        canonical_origin(client)?;
        ensure!(
            single_header(headers, "origin")? == client,
            "invalid_client"
        );
        Ok(())
    }
    fn session_id(&self, inner: &Inner, headers: &HeaderMap, owner: bool) -> Result<String> {
        self.session_id_for(inner, headers, |authority| {
            !owner || matches!(authority, Authority::Owner(_))
        })
    }
    fn session_id_for(
        &self,
        inner: &Inner,
        headers: &HeaderMap,
        accept: impl Fn(Authority) -> bool,
    ) -> Result<String> {
        let origin = self.request_origin(headers)?;
        let policy = OwnerCookiePolicy::for_origin(&origin);
        // Browsers can send non-ASCII bytes in unrelated cookies. Select the
        // credential by name before validating its value, while rejecting
        // malformed or ambiguous selected credentials.
        let mut found = None;
        for cookie in headers.get_all(header::COOKIE) {
            for pair in cookie.as_bytes().split(|byte| *byte == b';') {
                let pair = pair.trim_ascii();
                let (key, value) = match pair.iter().position(|byte| *byte == b'=') {
                    Some(index) => (&pair[..index], &pair[index + 1..]),
                    None => (pair, &[][..]),
                };
                if key == policy.name.as_bytes() {
                    ensure!(found.is_none(), "duplicate_session_cookie");
                    found = Some(value);
                }
            }
        }
        let value = found.ok_or_else(|| anyhow!("missing_session_cookie"))?;
        ensure!(
            !value.is_empty() && value.len() <= 256 && value.is_ascii(),
            "invalid_session"
        );
        let value = std::str::from_utf8(value).map_err(|_| anyhow!("invalid_session"))?;
        let id = hash(value);
        ensure!(
            inner
                .sessions
                .get(&id)
                .or_else(|| inner.anonymous.get(&id))
                .is_some_and(|s| s.expires > self.now()
                    && accept(s.authority)
                    && origin == s.origin),
            "owner_login_required"
        );
        Ok(id)
    }
    fn session(
        &self,
        inner: &mut Inner,
        headers: &HeaderMap,
        owner: bool,
        source: &ClientSource,
    ) -> Result<(String, Option<String>)> {
        if let Ok(id) = self.session_id(inner, headers, owner) {
            return Ok((id, None));
        }
        let partitioned = !self.config.client_address_policies.is_empty();
        if partitioned {
            ensure!(
                inner
                    .anonymous
                    .values()
                    .filter(|session| session.source.as_ref() == Some(source))
                    .count()
                    < CLIENT_SIGN_IN_LIMIT,
                "slow_down"
            );
            ensure!(
                inner.anonymous.len() < MAX_TRANSIENT,
                "authorization_capacity"
            );
        }
        if inner.anonymous.len() >= MAX_TRANSIENT {
            if let Some(oldest) = inner
                .anonymous
                .iter()
                .min_by_key(|(_, s)| s.expires)
                .map(|(id, _)| id.clone())
            {
                inner.anonymous.remove(&oldest);
                inner.anonymous_csrf.retain(|_, r| r.session != oldest);
            }
        }
        let token = random("anonymous_");
        let id = hash(&token);
        let mut session = Session::new(
            self.request_origin(headers)?,
            Authority::Anonymous,
            self.now() + 600,
        );
        session.source = partitioned.then(|| source.clone());
        inner.anonymous.insert(id.clone(), session);
        Ok((id, Some(token)))
    }
    fn record_sign_in_failure(&self, reason: sign_in_audit::Reason, entry_point: Option<String>) {
        let at = self.now();
        self.sign_in_audit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .record(at, reason, entry_point.clone());
        // Emit after releasing the audit lock. No submitted values or raw errors
        // enter either the event or the history, even when authentication is broken.
        tracing::warn!(
            target: "agent_connect_gateway::owner_sign_in",
            event = "owner_sign_in_failed",
            at,
            reason = reason.code(),
            entry_point = entry_point.as_deref(),
            "Owner sign-in failed"
        );
    }

    fn with_cookie(
        &self,
        mut response: Response,
        cookie: Option<String>,
        origin: &str,
    ) -> Response {
        if let Some(cookie) = cookie {
            response.headers_mut().insert(
                header::SET_COOKIE,
                OwnerCookiePolicy::for_origin(origin).header(&cookie, 43200),
            );
        }
        response
    }
}

async fn endpoint(State(service): State<Arc<AuthService>>, request: Request) -> Response {
    let permit = service.requests.try_acquire();
    let (parts, body) = request.into_parts();
    let peer = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let path = parts.uri.path().to_string();
    let query = parts.uri.query().unwrap_or("").to_string();
    let origin = parts
        .headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let is_owner = path.starts_with(OWNER) || path == AUTHORIZE;
    let is_sign_in = parts.method == Method::POST && path == LOGIN;
    let entry_point = if is_sign_in {
        service.entry_point(&parts.headers).ok()
    } else {
        None
    };
    let mut sign_in_reason = None;
    let result = if permit.is_err() {
        sign_in_reason = Some(sign_in_audit::Reason::ConcurrencyLimited);
        Err(anyhow!("slow_down"))
    } else {
        match to_bytes(body, MAX_BODY).await {
            Ok(body) => {
                let service = service.clone();
                let path = path.clone();
                tokio::task::spawn_blocking(move || {
                    service.dispatch(parts.method, &path, &query, &parts.headers, &body, peer)
                })
                .await
                .unwrap_or_else(|_| Err(anyhow!("authorization unavailable")))
            }
            Err(_) => {
                sign_in_reason = Some(sign_in_audit::Reason::InvalidBody);
                Err(anyhow!("invalid_request"))
            }
        }
    };
    let mut response = result.unwrap_or_else(|error| {
        let mut message = error.to_string();
        sign_in_reason.get_or_insert_with(|| sign_in_audit::Reason::from_error(&message));
        // A failed sign-in never says which part failed: a separate answer for
        // the code would confirm the passphrase. The audit keeps the real reason.
        if error.is::<SignInRetry>()
            && [
                "invalid_passphrase",
                "invalid_passkey",
                "invalid_factor",
                "factor_rate_limited",
            ]
            .contains(&message.as_str())
        {
            message = "invalid_credentials".to_string();
        }
        let code = if [
            "invalid_client",
            "invalid_target",
            "invalid_grant",
            "unsupported_grant_type",
            "invalid_authorization_details",
            "slow_down",
        ]
        .contains(&message.as_str())
        {
            message.as_str()
        } else {
            "invalid_request"
        };
        // Never return storage errors, password data or enrollment material in errors.
        let status = if message.contains("unavailable") {
            StatusCode::SERVICE_UNAVAILABLE
        } else if [
            "owner_login_required",
            "invalid_session",
            "missing_session_cookie",
            "duplicate_session_cookie",
            "invalid_csrf",
            "invalid_owner_origin",
        ]
        .contains(&message.as_str())
        {
            StatusCode::FORBIDDEN
        } else if ["invalid_credentials", "invalid_passkey"].contains(&message.as_str()) {
            StatusCode::UNAUTHORIZED
        } else if message.ends_with("rate_limited") || message == "slow_down" {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::BAD_REQUEST
        };
        if is_owner {
            let retry = error
                .downcast_ref::<SignInRetry>()
                .map(|retry| retry.target.as_str());
            owner_error(status, &message, &path, retry)
        } else {
            json_response(status, json!({"error":code}))
        }
    });
    if is_sign_in && (response.status().is_client_error() || response.status().is_server_error()) {
        // The global request limit returns an Ok(429) from dispatch before form
        // validation; capture it here alongside every Err rejection exactly once.
        let reason =
            sign_in_reason.unwrap_or(if response.status() == StatusCode::TOO_MANY_REQUESTS {
                sign_in_audit::Reason::RequestRateLimited
            } else {
                sign_in_audit::Reason::InvalidRequest
            });
        service.record_sign_in_failure(reason, entry_point);
    }
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    let html_response = headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"text/html"));
    headers.insert(
        "referrer-policy",
        HeaderValue::from_static(if html_response {
            "same-origin"
        } else {
            "no-referrer"
        }),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    if !headers.contains_key("content-security-policy") {
        headers.insert("content-security-policy",HeaderValue::from_static("default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'none'"));
    }
    if !is_owner {
        if let Some(origin) = origin {
            if canonical_origin(&origin).is_ok() {
                headers.insert(
                    "access-control-allow-origin",
                    HeaderValue::from_str(&origin).unwrap(),
                );
                headers.insert(header::VARY, HeaderValue::from_static("Origin"));
            }
        }
    }
    response
}

fn hash_passphrase(passphrase: &str) -> Result<String> {
    ensure!(
        passphrase.chars().count() >= 12 && passphrase.len() <= 1024,
        "owner passphrase must contain at least 12 characters and at most 1024 bytes"
    );
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(passphrase.as_bytes(), &salt)
        .map_err(|_| anyhow!("password hashing failed"))?
        .to_string())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn revoke_grant(grant: &mut Grant, now: u64) -> bool {
    if grant.revoked {
        return false;
    }
    grant.revoked = true;
    grant.revoked_at = Some(now);
    grant.access_hash = None;
    grant.refresh_hash = None;
    grant.access_expires = 0;
    true
}

fn revoke_all_grants(grants: &mut [Grant], now: u64) -> usize {
    grants
        .iter_mut()
        .map(|grant| usize::from(revoke_grant(grant, now)))
        .sum()
}

/// Validates private owner state under the exclusive lock, applies an offline
/// recovery change and saves only when it reports one.
fn recover(
    state_dir: &std::path::Path,
    change: impl FnOnce(&mut Stored) -> Result<bool>,
) -> Result<bool> {
    let metadata = fs::symlink_metadata(state_dir)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "invalid authorization state directory"
    );
    #[cfg(unix)]
    ensure!(
        metadata.permissions().mode() & 0o077 == 0,
        "authorization state must be private"
    );
    let directory = state_dir.to_path_buf();
    let _lock = authorization_lock(&directory)?;
    let path = directory.join("authorization.json");
    let metadata = fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= MAX_STATE,
        "invalid authorization state file"
    );
    #[cfg(unix)]
    ensure!(
        metadata.permissions().mode() & 0o077 == 0,
        "authorization state must be private"
    );
    let mut stored: Stored = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        stored.version == STATE_VERSION && stored.grants.len() <= MAX_GRANTS,
        "invalid authorization state"
    );
    canonical_origin(&stored.issuer)?;
    PasswordHash::new(&stored.password_hash).map_err(|_| anyhow!("invalid stored owner hash"))?;
    let changed = change(&mut stored)?;
    if changed {
        save(&directory, &stored)?;
    }
    Ok(changed)
}

fn authorization_lock(directory: &PathBuf) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let lock = options.open(directory.join("authorization.lock"))?;
    #[cfg(unix)]
    lock.set_permissions(fs::Permissions::from_mode(0o600))?;
    #[cfg(unix)]
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "authorization state is already open; stop the gateway before recovery"
    );
    Ok(lock)
}
fn private_directory(path: &PathBuf) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "authorization state directory must be a real directory"
        );
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn save(directory: &PathBuf, stored: &Stored) -> Result<()> {
    let bytes = serde_json::to_vec(stored)?;
    ensure!(
        bytes.len() as u64 <= MAX_STATE,
        "authorization state capacity"
    );
    let temporary = directory.join(format!(".authorization-{}.tmp", random("")));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join("authorization.json"))?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn canonical_origin(value: &str) -> Result<()> {
    let url = Url::parse(value)?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    ensure!(
        (url.scheme() == "https" || (url.scheme() == "http" && local))
            && url.username().is_empty()
            && url.password().is_none()
            && value == url.origin().ascii_serialization(),
        "invalid_client"
    );
    Ok(())
}
fn valid_redirect(value: &str, client: &str) -> Result<()> {
    let url = Url::parse(value)?;
    ensure!(
        url.origin().ascii_serialization() == client
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.as_str() == value
            && value.len() <= 2048,
        "invalid_request"
    );
    Ok(())
}
fn bounded(value: &str, max: usize) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control),
        "invalid_request"
    );
    Ok(())
}
fn fields(bytes: &[u8], allowed: &[&str]) -> Result<BTreeMap<String, String>> {
    ensure!(bytes.len() <= MAX_BODY, "invalid_request");
    let pairs: Vec<(String, String)> = serde_urlencoded::from_bytes(bytes)?;
    let mut result = BTreeMap::new();
    for (key, value) in pairs {
        ensure!(
            allowed.contains(&key.as_str()) && !result.contains_key(&key),
            "invalid_request"
        );
        result.insert(key, value);
    }
    Ok(result)
}
fn form(headers: &HeaderMap, body: &[u8], allowed: &[&str]) -> Result<BTreeMap<String, String>> {
    let content = single_header(headers, "content-type")?;
    ensure!(
        content == "application/x-www-form-urlencoded"
            || content == "application/x-www-form-urlencoded;charset=UTF-8"
            || content == "application/x-www-form-urlencoded; charset=UTF-8",
        "invalid_request"
    );
    fields(body, allowed)
}
fn required<'a>(form: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str> {
    form.get(key)
        .filter(|v| !v.is_empty())
        .map(String::as_str)
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .ok_or_else(|| anyhow!("invalid_request"))?
        .to_str()?;
    ensure!(values.next().is_none(), "invalid_request");
    Ok(value)
}
fn validate_tools(value: &Value) -> Result<Vec<Tool>> {
    let tools: Vec<Tool> = serde_json::from_value(value.clone())?;
    ensure!(
        !tools.is_empty() && tools.len() <= 32,
        "invalid_authorization_details"
    );
    let mut names = std::collections::HashSet::new();
    for tool in &tools {
        let bytes = tool.name.as_bytes();
        ensure!(
            !bytes.is_empty()
                && bytes.len() <= 64
                && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
                && bytes
                    .iter()
                    .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
                && names.insert(&tool.name),
            "invalid_authorization_details"
        );
        ensure!(
            !tool.description.is_empty()
                && tool.description.chars().count() <= 2000
                && tool.schema.is_object(),
            "invalid_authorization_details"
        );
    }
    Ok(tools)
}
fn tool_definitions(tools: &[Tool]) -> BTreeMap<String, Value> {
    tools
        .iter()
        .map(|t| {
            (
                t.name.clone(),
                serde_json::to_value(t).expect("serializable tool"),
            )
        })
        .collect()
}
fn snapshot(tools: &[Tool]) -> BTreeMap<String, Value> {
    tools
        .iter()
        .map(|t| (t.name.clone(), t.schema.clone()))
        .collect()
}
fn profile_label(profile: PermissionProfile) -> &'static str {
    match profile {
        PermissionProfile::Sandboxed => "Sandboxed native tools",
        PermissionProfile::ReadOnly => "Read-only native tools",
        PermissionProfile::DenyAll => "Deny permission requests",
        PermissionProfile::AppToolsOnly => "Application tool permission requests only",
    }
}
fn profile_summary(profile: PermissionProfile) -> &'static str {
    match profile {
        PermissionProfile::Sandboxed => "Its own tools run freely inside a disposable box.",
        PermissionProfile::ReadOnly => "Its own tools can read but not write.",
        PermissionProfile::DenyAll => {
            "Permission requests are denied; actions that do not ask may still run."
        }
        PermissionProfile::AppToolsOnly => {
            "Only this app’s tool requests are allowed; actions that do not ask may still run."
        }
    }
}
fn profile_description(profile: PermissionProfile, harness: Harness) -> &'static str {
    match profile {
        PermissionProfile::Sandboxed => {
            "The agent’s own tools work freely inside the disposable box, and all approved app tools are allowed. Approved apps can still reach the shared agent login and other apps’ conversations."
        }
        PermissionProfile::ReadOnly => {
            "The agent’s own tools can read but not write. Approved app tools still work and other permission requests are denied. If this host cannot start the agent’s sandbox, sessions refuse to run instead of running unrestricted."
        }
        PermissionProfile::DenyAll if harness == Harness::Claude => {
            "Claude Code’s permission requests are denied. Actions that do not ask for permission may still run, so this does not block every action of its own tools."
        }
        PermissionProfile::AppToolsOnly if harness == Harness::Claude => {
            "Only permission requests tied to this app’s tools are allowed; others are denied. Matching depends on the adapter, and actions that do not ask for permission may still run."
        }
        PermissionProfile::DenyAll => {
            "Permission requests are denied. Actions that do not ask for permission may still run."
        }
        PermissionProfile::AppToolsOnly => {
            "Only permission requests tied to approved app tools are allowed. Actions that do not ask for permission may still run."
        }
    }
}
fn active(g: &Grant, now: u64, fingerprint: &str) -> bool {
    !g.revoked && g.expires > now && g.fingerprint == fingerprint
}
fn random(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes))
}
fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
fn pkce_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._~-".contains(&c))
}
/// No downgrade: only a passkey sign-in removes a passkey.
fn may_remove(signed_in: FactorKind, target: FactorKind) -> bool {
    signed_in == FactorKind::Passkey || target == FactorKind::Totp
}
fn csrf(inner: &mut Inner, session: &str, action: &str, now: u64) -> String {
    // Only one outstanding challenge per session/action; bound page refresh growth.
    let csrf = if inner.anonymous.contains_key(session) {
        &mut inner.anonymous_csrf
    } else {
        &mut inner.csrf
    };
    csrf.retain(|_, r| r.session != session || r.action != action);
    let token = random("csrf_");
    if csrf.len() < MAX_TRANSIENT * 4 {
        csrf.insert(
            hash(&token),
            Csrf {
                session: session.into(),
                action: action.into(),
                expires: now + 600,
            },
        );
    }
    token
}
fn consume_csrf(
    inner: &mut Inner,
    session: &str,
    action: &str,
    token: &str,
    now: u64,
) -> Result<()> {
    let csrf = if inner.anonymous.contains_key(session) {
        &mut inner.anonymous_csrf
    } else {
        &mut inner.csrf
    };
    let record = csrf
        .remove(&hash(token))
        .ok_or_else(|| anyhow!("invalid_csrf"))?;
    ensure!(
        record.session == session && record.action == action && record.expires > now,
        "invalid_csrf"
    );
    Ok(())
}
fn authorize_url(client: &str, uri: &str) -> String {
    format!(
        "{AUTHORIZE}?{}",
        serde_urlencoded::to_string([("client_id", client), ("request_uri", uri)]).unwrap()
    )
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn hidden(name: &str, value: &str) -> String {
    format!(
        "<input type=hidden name='{name}' value='{}'>",
        escape(value)
    )
}
// Styles are authorized by their SHA-256 CSP hashes, never unsafe-inline.
fn page_csp(client: Option<&str>, dynamic_css: &str, script: &str) -> String {
    let digest = |css: &str| {
        format!(
            "'sha256-{}'",
            base64::engine::general_purpose::STANDARD.encode(Sha256::digest(css.as_bytes()))
        )
    };
    let mut styles = digest(pages::STYLES);
    if !dynamic_css.is_empty() {
        styles = format!("{styles} {}", digest(dynamic_css));
    }
    let scripts = if script.is_empty() {
        String::new()
    } else {
        format!("; script-src {}", digest(script))
    };
    format!(
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'{}; style-src {styles}{scripts}",
        client
            .map(|origin| format!(" {origin}"))
            .unwrap_or_default()
    )
}

fn html(page: pages::Page) -> Response {
    html_for(page, None)
}
fn html_for(page: pages::Page, client: Option<&str>) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(
            "content-security-policy",
            page_csp(client, &page.dynamic_css, page.script),
        )
        .body(Body::from(pages::document(&page)))
        .unwrap()
}
fn session_mut<'a>(inner: &'a mut Inner, id: &str) -> Option<&'a mut Session> {
    match inner.sessions.get_mut(id) {
        Some(session) => Some(session),
        None => inner.anonymous.get_mut(id),
    }
}
/// Browsers allow passkeys only on a domain name, never on an IP literal.
fn passkey_possible(origin: &str) -> bool {
    Url::parse(origin).is_ok_and(|url| matches!(url.host(), Some(url::Host::Domain(_))))
}
/// The relying party for one address: its exact hostname as RP ID and its exact
/// origin, port included. Nothing is shared across addresses.
fn webauthn(origin: &str) -> Result<Webauthn> {
    ensure!(passkey_possible(origin), "passkey_unavailable");
    let url = Url::parse(origin)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("passkey_unavailable"))?;
    WebauthnBuilder::new(host, &url)
        .and_then(|builder| builder.rp_name("Agent Connect").build())
        .map_err(|_| anyhow!("passkey_unavailable"))
}

fn owner_error(status: StatusCode, reason: &str, path: &str, retry: Option<&str>) -> Response {
    let (title, message) = match reason {
        "invalid_credentials" => ("Sign-in failed", "Try again."),
        "invalid_passkey" => ("Passkey not accepted", "Try again."),
        "invalid_factor" => (
            "Authenticator code not accepted",
            "Enter a fresh six-digit code from your enrolled authenticator. A code already used for sign-in or approval cannot be reused.",
        ),
        "missing_session_cookie" if path == LOGIN => (
            "Please sign in again",
            "The sign-in session cookie was not sent. Return to sign-in and allow cookies for this gateway before trying again.",
        ),
        "duplicate_session_cookie" if path == LOGIN => (
            "Please sign in again",
            "More than one sign-in session cookie was sent. Clear this gateway's cookies, then return to sign-in.",
        ),
        "owner_login_required"
        | "invalid_session"
        | "missing_session_cookie"
        | "duplicate_session_cookie" => (
            "Please sign in again",
            "Your owner session is missing or has expired. Sign in to review the request or manage application access.",
        ),
        "invalid_csrf" | "invalid_owner_origin" => (
            "Refresh this page to continue",
            "This form could not be verified. Return to a fresh gateway page before trying again.",
        ),
        "login_rate_limited" | "factor_rate_limited" => (
            "Too many attempts",
            "Wait before trying again. Sign-in attempts are limited for your connection; clients behind the same proxy may share that limit.",
        ),
        "invalid_profile" => (
            "Choose an available profile",
            "Reload this request and select one of the profiles configured by the gateway owner before approving access.",
        ),
        "invalid_enrollment" => (
            "Setup expired",
            "Sign in with the passphrase to start setup again, and finish it within 10 minutes.",
        ),
        "factor_already_enrolled" => (
            "Already set up",
            "This address already has a passkey or authenticator. Sign in with it.",
        ),
        "passkey_required" => (
            "A passkey is needed",
            "Only a sign-in with a passkey can remove a passkey.",
        ),
        "authorization_capacity" | "grant_capacity" | "slow_down" => (
            "Gateway is busy",
            "The gateway cannot accept this request right now. Try again after pending requests expire or access is revoked.",
        ),
        _ if reason.contains("unavailable") => (
            "Authorization unavailable",
            "The gateway cannot safely authorize access right now. The owner must check the gateway before trying again.",
        ),
        _ => (
            "Request could not be completed",
            "This request may have expired or contains information the gateway cannot accept. Review pending requests from the owner console, or start a fresh connection from the application.",
        ),
    };
    let (target, label) = if path == LOGIN
        || matches!(
            reason,
            "owner_login_required"
                | "invalid_session"
                | "missing_session_cookie"
                | "duplicate_session_cookie"
        ) {
        (retry.unwrap_or(LOGIN), "Return to sign-in")
    } else {
        (OWNER, "Back to Activity")
    };
    let mut response = html(pages::error(title, message, target, label));
    *response.status_mut() = status;
    response
}

fn json_response(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}
fn redirect(target: &str) -> Result<Response> {
    Ok(Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, HeaderValue::from_str(target)?)
        .body(Body::empty())?)
}
fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut buffer = 0u32;
    let mut bits = 0;
    let mut result = String::new();
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            result.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        result.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    result
}
fn decode_secret(secret: &str) -> Result<Vec<u8>> {
    let mut buffer = 0u32;
    let mut bits = 0;
    let mut result = Vec::new();
    for byte in secret.bytes() {
        let digit = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
            .iter()
            .position(|b| *b == byte)
            .ok_or_else(|| anyhow!("invalid factor"))?;
        buffer = (buffer << 5) | digit as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            result.push((buffer >> bits) as u8);
        }
    }
    Ok(result)
}
fn totp(secret: &str, step: u64) -> Result<String> {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&decode_secret(secret)?)
        .map_err(|_| anyhow!("invalid factor"))?;
    mac.update(&step.to_be_bytes());
    let bytes = mac.finalize().into_bytes();
    let offset = (bytes[19] & 15) as usize;
    let number = u32::from_be_bytes(bytes[offset..offset + 4].try_into()?) & 0x7fffffff;
    Ok(format!("{:06}", number % 1_000_000))
}
fn verify_totp(secret: &str, code: &str, now: u64, last: Option<u64>) -> Result<u64> {
    ensure!(
        code.len() == 6 && code.bytes().all(|c| c.is_ascii_digit()),
        "invalid_factor"
    );
    let step = now / 30;
    let mut matched = None;
    for candidate in [step.saturating_sub(1), step, step + 1] {
        if equal(&totp(secret, candidate)?, code) && last.is_none_or(|last| candidate > last) {
            matched = Some(candidate);
        }
    }
    matched.ok_or_else(|| anyhow!("invalid_factor"))
}

mod pages;
mod sign_in_audit;
#[cfg(test)]
mod tests;

fn attempt_budget(
    budgets: &mut HashMap<ClientSource, AttemptBudget>,
    source: &ClientSource,
    now: u64,
    period: u64,
    limit: u32,
    error: &str,
    partitioned: bool,
) -> Result<ClientSource> {
    budgets.retain(|_, budget| now.saturating_sub(budget.window) < period);
    let mut source = source.clone();
    if !budgets.contains_key(&source) {
        if partitioned {
            // Reserved missing-header groups (at most 17 configured origins) and
            // overflow groups (those origins plus transport) remain bounded too.
            // Keep new sources in an active overflow group until its window
            // expires, even if an individual slot expires earlier.
            if !source.reserved()
                && (budgets.contains_key(&source.overflow())
                    || budgets.keys().filter(|key| !key.reserved()).count() >= MAX_CLIENT_BUDGETS)
            {
                source = source.overflow();
            }
        } else if budgets.len() >= MAX_CLIENT_BUDGETS {
            // Preserve the original oldest-IP eviction policy without opt-in.
            if let Some(oldest) = budgets
                .iter()
                .min_by_key(|(_, budget)| budget.window)
                .map(|(key, _)| key.clone())
            {
                budgets.remove(&oldest);
            }
        }
    }
    if let Some(budget) = budgets.get(&source) {
        ensure!(budget.count < limit, "{error}");
    }
    Ok(source)
}
/// Count one attempt against the source `attempt_budget` chose. The window
/// starts at the first counted attempt, never at a success.
fn spend(budgets: &mut HashMap<ClientSource, AttemptBudget>, source: &ClientSource, now: u64) {
    budgets
        .entry(source.clone())
        .or_insert(AttemptBudget {
            window: now,
            count: 0,
        })
        .count += 1;
}
/// A guess limit counts only guesses that were wrong: a passphrase, passkey or
/// code not accepted. Successes, and refusals that guessed nothing, spend nothing.
fn spend_on_wrong_guess<T>(
    budgets: &mut HashMap<ClientSource, AttemptBudget>,
    source: &ClientSource,
    now: u64,
    result: Result<T>,
) -> Result<T> {
    if let Err(error) = &result
        && ["invalid_passphrase", "invalid_passkey", "invalid_factor"]
            .contains(&error.to_string().as_str())
    {
        spend(budgets, source, now);
    }
    result
}
