//! Gateway-owned owner authentication and exact-origin OAuth grants.
//!
//! ACP and MCP-over-ACP remain unstable. Application bearers are never owner
//! credentials. Keep this service's private state outside every harness home.
use crate::{Harness, policy::PermissionProfile};
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
#[cfg(not(test))]
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

const OWNER: &str = "/agent-connect/owner";
const LOGIN: &str = "/agent-connect/owner/login";
const AUTHORIZE: &str = "/agent-connect/oauth/authorize";
const TOKEN: &str = "/agent-connect/oauth/token";
const PAR: &str = "/agent-connect/oauth/par";
const REVOKE: &str = "/agent-connect/oauth/revoke";
const COOKIE: &str = "agent_connect_owner";
const REQUEST_TTL: u64 = 600;
const CODE_TTL: u64 = 120;
const ACCESS_TTL: u64 = 300;
const MAX_DURATION: u64 = 30 * 24 * 3600;
const MAX_TRANSIENT: usize = 256;
const MAX_GRANTS: usize = 256;
const MAX_BODY: usize = 128 * 1024;
const MAX_SPENT_REFRESH: usize = 16384;
const MAX_STATE: u64 = 32 * 1024 * 1024;

pub struct AuthConfig {
    /// A canonical HTTPS origin, or an HTTP loopback origin for local use.
    pub public_url: String,
    pub state_dir: PathBuf,
    pub policy_fingerprint: String,
    /// Additional trusted origins; each grant uses its selected entry-point issuer.
    pub entry_points: Vec<String>,
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
    totp_secret: Option<String>,
    last_totp_step: Option<u64>,
    #[serde(default)]
    totp_reset_count: u64,
    #[serde(default)]
    last_totp_reset_at: Option<u64>,
    grants: Vec<Grant>,
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
struct Session {
    origin: String,
    expires: u64,
    owner: bool,
    enrollment: Option<(String, u64)>,
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
    login_budgets: HashMap<IpAddr, AttemptBudget>,
    factor_budgets: HashMap<IpAddr, AttemptBudget>,
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
                let stored: Stored = serde_json::from_slice(&fs::read(&path)?)?;
                ensure!(
                    stored.version == 1
                        && stored.issuer == config.public_url
                        && stored.grants.len() <= MAX_GRANTS,
                    "authorization state does not match gateway"
                );
                PasswordHash::new(&stored.password_hash)
                    .map_err(|_| anyhow!("invalid stored owner hash"))?;
                if let Some(secret) = &stored.totp_secret {
                    ensure!(decode_secret(secret)?.len() == 20, "invalid stored factor");
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
                ensure!(
                    passphrase.chars().count() >= 12 && passphrase.len() <= 1024,
                    "owner passphrase must contain at least 12 characters and at most 1024 bytes"
                );
                let salt = SaltString::generate(&mut OsRng);
                let hash = Argon2::default()
                    .hash_password(passphrase.as_bytes(), &salt)
                    .map_err(|_| anyhow!("password hashing failed"))?
                    .to_string();
                let stored = Stored {
                    version: 1,
                    issuer: config.public_url.clone(),
                    password_hash: hash,
                    totp_secret: None,
                    last_totp_step: None,
                    totp_reset_count: 0,
                    last_totp_reset_at: None,
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

    /// Owner-run recovery only: refuse active serving, never bootstrap missing state,
    /// preserve the passphrase and all grants, and record bounded recovery metadata.
    pub fn reset_totp(state_dir: &std::path::Path) -> Result<bool> {
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
            stored.version == 1 && stored.grants.len() <= MAX_GRANTS,
            "invalid authorization state"
        );
        canonical_origin(&stored.issuer)?;
        PasswordHash::new(&stored.password_hash)
            .map_err(|_| anyhow!("invalid stored owner hash"))?;
        let enrolled = stored.totp_secret.is_some();
        if enrolled {
            stored.totp_secret = None;
            stored.last_totp_step = None;
            stored.totp_reset_count = stored
                .totp_reset_count
                .checked_add(1)
                .ok_or_else(|| anyhow!("recovery audit capacity"))?;
            stored.last_totp_reset_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_secs(),
            );
            save(&directory, &stored)?;
        }
        Ok(enrolled)
    }

    fn profile_choices(&self) -> String {
        let options = self
            .config
            .profiles
            .iter()
            .map(|profile| {
                format!(
                    "<option value='{}'{}>{}</option>",
                    profile.as_str(),
                    if *profile == self.config.default_profile {
                        " selected"
                    } else {
                        ""
                    },
                    escape(profile_label(*profile))
                )
            })
            .collect::<String>();
        let descriptions = self
            .config
            .profiles
            .iter()
            .map(|profile| {
                format!(
                    "<p class='help'><strong>{}</strong>: {}</p>",
                    escape(profile_label(*profile)),
                    escape(profile_description(*profile, self.config.harness))
                )
            })
            .collect::<String>();
        format!(
            "<div class='field'><label for='restricted-profile'>Restricted profile</label><select id='restricted-profile' name=profile required aria-describedby='profile-help'>{options}</select><div id='profile-help'>{descriptions}</div></div>"
        )
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
            "/agent-connect/owner/forget-browser",
            "/agent-connect/owner/grants/revoke-all",
            "/agent-connect/owner/sessions/end",
            "/agent-connect/owner/grants/revoke",
            "/agent-connect/owner/totp",
            "/agent-connect/owner/totp/enroll",
            "/agent-connect/owner/totp/verify",
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
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
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
        peer: IpAddr,
    ) -> Result<Response> {
        let runtime_view =
            if method == Method::GET && (path == OWNER || path == "/agent-connect/owner/totp") {
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
        if now.saturating_sub(inner.rate_window) >= 60 {
            inner.rate_window = now;
            inner.rate_count = 0;
        }
        inner.rate_count = inner.rate_count.saturating_add(1);
        if inner.rate_count > 600 && self.session_id(&inner, headers, true).is_err() {
            return Ok(if path.starts_with(OWNER) || path == AUTHORIZE {
                owner_error(StatusCode::TOO_MANY_REQUESTS, "slow_down", path)
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
            let continuation = self.continuation(&inner, &args)?;
            let (session, cookie) = self.session(&mut inner, headers, false)?;
            let csrf = csrf(&mut inner, &session, &format!("login:{continuation}"), now);
            let factor = if inner.stored.totp_secret.is_some() {
                "<div class='field'><label for='login-totp'>Authenticator code</label><input id='login-totp' name=totp inputmode=numeric pattern='[0-9]{6}' autocomplete=one-time-code required aria-describedby='login-totp-help'><p id='login-totp-help' class='help'>Enter a fresh six-digit code from your enrolled authenticator.</p></div>"
            } else {
                ""
            };
            let body = format!(
                "<div class='compact'><p class='eyebrow'>Gateway owner</p><h1>Sign in to Agent Connect</h1><p class='lede'>Review application requests and manage the access you have approved.</p><form method=post action='{LOGIN}'>{}<div class='field'><label for='owner-passphrase'>Owner passphrase</label><input id='owner-passphrase' type=password name=passphrase autocomplete=current-password required maxlength=1024 aria-describedby='passphrase-help'><p id='passphrase-help' class='help'>Use the passphrase you chose when setting up this gateway. Applications cannot sign in with their access tokens.</p></div>{factor}<div class='actions'><button>Sign in</button></div></form></div>",
                hidden("csrf_token", &csrf) + &hidden("continue", &continuation)
            );
            return Ok(self.with_cookie(html(&body), cookie, &self.request_origin(headers)?));
        }
        if method == Method::POST && path == LOGIN {
            self.owner_origin(headers)?;
            let form = form(
                headers,
                body,
                &["csrf_token", "continue", "passphrase", "totp"],
            )?;
            let session = self.session_id(&inner, headers, false)?;
            let continuation = form.get("continue").cloned().unwrap_or_default();
            // Continuation is authenticated by the one-use CSRF binding and is never a caller URL.
            consume_csrf(
                &mut inner,
                &session,
                &format!("login:{continuation}"),
                required(&form, "csrf_token")?,
                now,
            )?;
            attempt_budget(
                &mut inner.login_budgets,
                peer,
                now,
                900,
                10,
                "login_rate_limited",
            )?;
            let passphrase = required(&form, "passphrase")?;
            ensure!(passphrase.len() <= 1024, "invalid_credentials");
            let parsed = PasswordHash::new(&inner.stored.password_hash)
                .map_err(|_| anyhow!("invalid_credentials"))?;
            ensure!(
                Argon2::default()
                    .verify_password(passphrase.as_bytes(), &parsed)
                    .is_ok(),
                "invalid_credentials"
            );
            self.verify_factor(
                &mut inner,
                form.get("totp").map(String::as_str).unwrap_or(""),
                peer,
            )?;
            inner.login_budgets.remove(&peer);
            inner.sessions.remove(&session);
            inner.anonymous.remove(&session);
            ensure!(
                inner.sessions.len() < MAX_TRANSIENT,
                "authorization_capacity"
            );
            let token = random("owner_");
            inner.sessions.insert(
                hash(&token),
                Session {
                    origin: self.request_origin(headers)?,
                    owner: true,
                    expires: now + 12 * 3600,
                    enrollment: None,
                },
            );
            let target = if continuation.is_empty() {
                OWNER.to_string()
            } else {
                // Reparse to defend against forged state from future callers of this method.
                ensure!(
                    continuation.starts_with(&format!("{AUTHORIZE}?")),
                    "invalid_request"
                );
                continuation
            };
            return Ok(self.with_cookie(
                redirect(&target)?,
                Some(token),
                &self.request_origin(headers)?,
            ));
        }
        if method == Method::GET && (path == OWNER || path == "/agent-connect/owner/totp") {
            let Ok(session) = self.session_id(&inner, headers, true) else {
                return redirect(LOGIN);
            };
            ensure!(query.is_empty(), "invalid_request");
            let active_count = inner
                .stored
                .grants
                .iter()
                .filter(|g| self.grant_active(g, now))
                .count();
            let mut body = format!(
                "<header class='page-heading'><div><p class='eyebrow'>Gateway owner</p><h1>Application access</h1><p class='lede'>Review requests and manage the authority applications hold through your gateway.</p></div><div class='counts' role='group' aria-label='Access summary'><span><strong>{}</strong>Pending</span><span><strong>{active_count}</strong>Active</span></div></header>{}<section class='management' aria-labelledby='pending-title'><header><h2 id='pending-title'>Pending requests</h2><p class='help'>Each request needs your decision and expires automatically.</p></header>",
                inner.pending.len(),
                runtime_view.as_ref().map(|view| view.problems.iter().map(|problem| format!("<div class='alert runtime-problem' role='status'><strong>{}</strong><p>{}</p></div>", escape(&problem.message), escape(&problem.repair))).collect::<String>()).unwrap_or_default()
            );
            if inner.pending.is_empty() {
                body.push_str("<div class='empty'><strong>No decisions waiting</strong><p>When an application asks to connect, its request will appear here for you to review.</p></div>");
            }
            for (uri, pending) in &inner.pending {
                body.push_str(&format!("<article class='record'><div class='record-heading'><div><h3>{}</h3><p class='origin'>{}</p></div><span class='status pending'>Pending</span></div><p class='help'>Expires {} · {} application tools</p><div class='actions'><a class='button' href='{}'>Review request</a></div></article>", escape(&pending.client_name), escape(&pending.client), utc_time(pending.expires), pending.tools.len(), escape(&authorize_url(&pending.client, uri))));
            }
            body.push_str("</section><section class='management' aria-labelledby='grants-title'><header><h2 id='grants-title'>Approved applications</h2><p class='help'>Access ends when a grant expires or you revoke it. Revocation cannot undo completed effects.</p></header>");
            if inner.stored.grants.is_empty() {
                body.push_str("<div class='empty'><strong>No applications approved yet</strong><p>Approved applications will appear here with their exact origin, fixed tools and expiration date.</p></div>");
            }
            for grant in inner.stored.grants.clone() {
                let status = if grant.revoked {
                    "Revoked"
                } else if grant.expires <= now {
                    "Expired"
                } else if !self.grant_active(&grant, now) {
                    "Policy changed"
                } else {
                    "Active"
                };
                let action = if status == "Active" {
                    let token = csrf(&mut inner, &session, &format!("revoke:{}", grant.id), now);
                    format!(
                        "<form method=post action='/agent-connect/owner/grants/revoke'>{}{}<button class='danger'>Revoke access</button></form>",
                        hidden("csrf_token", &token),
                        hidden("grant_id", &grant.id)
                    )
                } else {
                    String::new()
                };
                body.push_str(&format!("<article class='record'><div class='record-heading'><h3 class='origin'>{}</h3><span class='status {}'>{status}</span></div><p class='help'>Profile: {} · Expires {}{}</p><details class='authority'><summary>View approved tools ({} tool{})</summary>{}</details><div class='actions'>{action}</div></article>", escape(&grant.client), if status == "Active" { "active" } else { "inactive" }, escape(profile_label(self.grant_profile(&grant))), utc_time(grant.expires), if status == "Active" { format!(" · {} remaining", duration_label(grant.expires.saturating_sub(now))) } else { String::new() }, grant.tools.len(), if grant.tools.len() == 1 { "" } else { "s" }, tool_cards(&grant.tools)));
            }
            body.push_str("</section><section class='management' aria-labelledby='sessions-title'><header><h2 id='sessions-title'>Live sessions</h2><p class='help'>Ending a session stops its running host and cleans up its resources. The application grant stays active.</p></header>");
            if let Some(view) = &runtime_view {
                if view.sessions.is_empty() {
                    body.push_str("<div class='empty'><strong>No live sessions</strong><p>Sessions appear here while their application hosts remain active.</p></div>");
                }
                for runtime_session in &view.sessions {
                    let token = csrf(
                        &mut inner,
                        &session,
                        &format!("end:{}", runtime_session.id),
                        now,
                    );
                    body.push_str(&format!("<article class='record'><div class='record-heading'><h3 class='origin'>{}</h3><span class='status'>{}</span></div><p class='help origin'>Session {}</p><form method=post action='/agent-connect/owner/sessions/end'>{}{}<div class='actions'><button class='danger'>End session</button></div></form></article>", escape(inner.stored.grants.iter().find(|grant| grant.id == runtime_session.grant_id).map(|grant| grant.client.as_str()).unwrap_or("Application unavailable")), escape(&runtime_session.state), escape(&runtime_session.id), hidden("session_id", &runtime_session.id), hidden("csrf_token", &token)));
                }
            } else {
                body.push_str("<div class='empty'><strong>Session status unavailable</strong><p>Check the gateway runtime before relying on session management.</p></div>");
            }
            body.push_str("</section><section class='management' aria-labelledby='profiles-title'><header><h2 id='profiles-title'>Restricted profiles</h2><p class='help'>Choose a configured profile when approving access. A grant keeps its chosen authority until expiry or revocation.</p></header>");
            for profile in &self.config.profiles {
                body.push_str(&format!(
                    "<article class='record'><h3>{}</h3><p class='help'>{}</p></article>",
                    escape(profile_label(*profile)),
                    escape(profile_description(*profile, self.config.harness))
                ));
            }
            if self.config.harness == Harness::Codex {
                body.push_str("<p class='help record'>Deny-all and app-tools-only profiles are unavailable for boxed Codex: native actions can run without permission requests.</p>");
            } else {
                body.push_str("<p class='help record'>Codex read-only mode is unavailable for Claude. Claude profiles govern permission requests; they do not guarantee that every native action requests permission.</p>");
            }
            body.push_str("</section><section class='management' aria-labelledby='entry-points-title'><header><h2 id='entry-points-title'>Gateway entry points</h2><p class='help'>Use a configured entry point to reach the gateway. Pair applications with the exact entry-point origin they will use. Owner sign-in and consent stay on that origin.</p></header><div class='record'>");
            for origin in
                std::iter::once(&self.config.public_url).chain(self.config.entry_points.iter())
            {
                body.push_str(&format!(
                    "<p class='origin'><a href='{}{OWNER}'>{}</a></p>",
                    escape(origin),
                    escape(origin)
                ));
            }
            body.push_str("</div>");
            body.push_str("</section><section class='management' aria-labelledby='security-title'><header><h2 id='security-title'>Owner sign-in security</h2><p class='help'>These controls protect the gateway owner. Application tokens cannot approve new access.</p></header><div class='record'>");
            if inner.stored.totp_secret.is_none() {
                let token = csrf(&mut inner, &session, "enroll", now);
                body.push_str(&format!("<h3>Add an authenticator</h3><p class='help'>Require a fresh authenticator code for each owner sign-in and each access approval.</p><form method=post action='/agent-connect/owner/totp/enroll'>{}<div class='field'><label for='enroll-passphrase'>Confirm owner passphrase</label><input id='enroll-passphrase' type=password name=passphrase autocomplete=current-password required maxlength=1024></div><div class='actions'><button class='secondary'>Create enrollment secret</button></div></form>", hidden("csrf_token", &token)));
            } else {
                body.push_str("<p class='status active'>Authenticator enrolled</p><p class='help'>A fresh code is required for every sign-in and access approval. Lost the authenticator? The gateway owner can stop the gateway and run agent-connect reset-totp, then sign in with the existing passphrase and enroll again. Application grants stay active.</p>");
            }
            let forget_token = csrf(&mut inner, &session, "forget-browser", now);
            let revoke_token = csrf(&mut inner, &session, "revoke-all", now);
            body.push_str(&format!("</div><div class='record'><h3>Forget this browser</h3><p class='help'>End this owner-console session before leaving a shared device. Application grants stay active.</p><form method=post action='/agent-connect/owner/forget-browser'>{}<div class='actions'><button class='secondary'>Forget this browser</button></div></form></div><div class='record'><h3>Revoke all application access</h3><p class='help'>Revoke all application grants. This browser stays signed in. Completed effects cannot be undone.</p><form method=post action='/agent-connect/owner/grants/revoke-all'>{}<div class='actions'><button class='danger'{}>Revoke all active grants</button></div></form></div>", hidden("csrf_token", &forget_token), hidden("csrf_token", &revoke_token), if active_count == 0 { " disabled" } else { "" }));
            let token = csrf(&mut inner, &session, "logout", now);
            body.push_str(&format!("<div class='record'><h3>End this owner session</h3><p class='help'>Sign out before leaving a shared device. Application grants stay active until they expire or are revoked.</p><form method=post action='/agent-connect/owner/logout'>{}<div class='actions'><button class='secondary'>Sign out</button></div></form></div></section>", hidden("csrf_token", &token)));
            return Ok(html(&body));
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
            return self.owner_post(&mut inner, path, headers, body, peer);
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
            let token = csrf(&mut inner, &session, &format!("consent:{uri}"), now);
            let mut response = html(&format!(
                "<p class='eyebrow'>Application request</p><h1>Allow {}?</h1><p class='lede'>Choose whether this application can use your selected harness through Agent Connect.</p><section class='origin-box' aria-label='Requesting application'><span class='help'>Exact application origin</span><strong class='origin'>{}</strong></section><section aria-labelledby='tools-title'><h2 id='tools-title'>Fixed application tools</h2><p class='help'>Only these tool names, descriptions and exact input schemas are approved by this request.</p>{}</section><section class='notice' aria-labelledby='authority-title'><h2 id='authority-title'>What this access allows</h2><p>The selected profile below bounds native authority inside a disposable box. Application tool effects follow the fixed tool approval. Sessions share a dedicated harness home: a consented application may obtain its dedicated login and read other applications’ transcripts.</p><p>Expiry and revocation stop further authorization; they cannot undo completed effects. ACP and MCP-over-ACP are unstable.</p></section><form method=post action='{AUTHORIZE}'>{}{}<div class='field'><label for='access-duration'>Access duration</label><select id='access-duration' name=duration aria-describedby='duration-help'><option value=3600>1 hour</option><option value=86400>1 day</option><option value=604800>7 days</option><option value=2592000>30 days</option></select><p id='duration-help' class='help'>You can revoke access at any time from the owner console.</p></div>{}{}<div class='actions'><button class='secondary' name=decision value=deny>Deny</button><button name=decision value=approve>Approve</button></div></form>",
                escape(&pending.client_name),
                escape(&pending.client),
                tool_cards(&pending.tools),
                hidden("request_uri", uri),
                hidden("csrf_token", &token),
                self.profile_choices(),
                if inner.stored.totp_secret.is_some() {
                    "<div class='field'><label for='approval-totp'>Fresh authenticator code</label><input id='approval-totp' name=totp inputmode=numeric autocomplete=one-time-code pattern='[0-9]{6}' aria-describedby='approval-help'><p id='approval-help' class='help'>A fresh code is required to approve access. You can deny this request without a code.</p></div>"
                } else {
                    ""
                }
            ));
            response.headers_mut().insert(
                "content-security-policy",
                HeaderValue::from_str(&page_csp(Some(&pending.client)))?,
            );
            return Ok(response);
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
            self.verify_factor(
                &mut inner,
                form.get("totp").map(String::as_str).unwrap_or(""),
                peer,
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
        grant.revoked = true;
        grant.access_hash = None;
        grant.refresh_hash = None;
        grant.access_expires = 0;
        self.commit(inner, next)
    }

    fn verify_factor(&self, inner: &mut Inner, code: &str, peer: IpAddr) -> Result<()> {
        let Some(secret) = inner.stored.totp_secret.clone() else {
            return Ok(());
        };
        self.factor_budget(inner, peer)?;
        let step = verify_totp(&secret, code, self.now(), inner.stored.last_totp_step)?;
        let mut next = inner.stored.clone();
        next.last_totp_step = Some(step);
        self.commit(inner, next)
    }
    fn factor_budget(&self, inner: &mut Inner, peer: IpAddr) -> Result<()> {
        attempt_budget(
            &mut inner.factor_budgets,
            peer,
            self.now(),
            60,
            5,
            "factor_rate_limited",
        )
    }
    fn owner_post(
        &self,
        inner: &mut Inner,
        path: &str,
        headers: &HeaderMap,
        body: &[u8],
        peer: IpAddr,
    ) -> Result<Response> {
        self.owner_origin(headers)?;
        let session = self.session_id(inner, headers, true)?;
        let now = self.now();
        match path {
            "/agent-connect/owner/logout" | "/agent-connect/owner/forget-browser" => {
                let form = form(headers, body, &["csrf_token"])?;
                consume_csrf(
                    inner,
                    &session,
                    if path.ends_with("forget-browser") {
                        "forget-browser"
                    } else {
                        "logout"
                    },
                    required(&form, "csrf_token")?,
                    now,
                )?;
                inner.sessions.remove(&session);
                inner.csrf.retain(|_, token| token.session != session);
                let mut response = redirect(LOGIN)?;
                response.headers_mut().insert(
                    header::SET_COOKIE,
                    HeaderValue::from_str(&format!(
                        "{COOKIE}=; Path=/agent-connect; HttpOnly; SameSite=Lax; Max-Age=0{}",
                        self.secure_cookie(&self.request_origin(headers)?)
                    ))?,
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
                for grant in &mut next.grants {
                    if !grant.revoked {
                        grant.revoked = true;
                        grant.access_hash = None;
                        grant.refresh_hash = None;
                        grant.access_expires = 0;
                    }
                }
                self.commit(inner, next)?;
                inner.codes.clear();
                redirect(OWNER)
            }
            "/agent-connect/owner/totp/enroll" => {
                let form = form(headers, body, &["csrf_token", "passphrase"])?;
                consume_csrf(
                    inner,
                    &session,
                    "enroll",
                    required(&form, "csrf_token")?,
                    now,
                )?;
                ensure!(
                    inner.stored.totp_secret.is_none(),
                    "factor_already_enrolled"
                );
                self.factor_budget(inner, peer)?;
                let passphrase = required(&form, "passphrase")?;
                ensure!(passphrase.len() <= 1024, "invalid_credentials");
                let parsed = PasswordHash::new(&inner.stored.password_hash)
                    .map_err(|_| anyhow!("invalid_credentials"))?;
                ensure!(
                    Argon2::default()
                        .verify_password(passphrase.as_bytes(), &parsed)
                        .is_ok(),
                    "invalid_credentials"
                );
                let mut bytes = [0u8; 20];
                OsRng.fill_bytes(&mut bytes);
                let secret = base32(&bytes);
                inner.sessions.get_mut(&session).unwrap().enrollment =
                    Some((secret.clone(), now + 600));
                let token = csrf(inner, &session, "factor_verify", now);
                let mut uri = Url::parse("otpauth://totp/Agent%20Connect:owner")?;
                uri.query_pairs_mut()
                    .append_pair("secret", &secret)
                    .append_pair("issuer", "Agent Connect")
                    .append_pair("algorithm", "SHA1")
                    .append_pair("digits", "6")
                    .append_pair("period", "30");
                Ok(html(&format!(
                    "<div class='compact'><p class='eyebrow'>Owner sign-in security</p><h1>Enroll authenticator</h1><p class='lede'>Add this secret to your authenticator, then enter a code to confirm enrollment.</p><section class='origin-box'><span class='help'>Enrollment secret — keep this private</span><code>{}</code></section><p><a href='{}'>Open authenticator</a></p><p class='help'>This enrollment expires in 10 minutes. After confirmation, a fresh code is required for sign-in and access approval. Keep access to the authenticator; recovery is not available through this page.</p><form method=post action='/agent-connect/owner/totp/verify'>{}<div class='field'><label for='enrollment-totp'>Authenticator code</label><input id='enrollment-totp' name=totp inputmode=numeric autocomplete=one-time-code pattern='[0-9]{{6}}' required></div><div class='actions'><a class='button secondary' href='/agent-connect/owner'>Back to owner console</a><button>Confirm enrollment</button></div></form></div>",
                    escape(&secret),
                    escape(uri.as_str()),
                    hidden("csrf_token", &token)
                )))
            }
            "/agent-connect/owner/totp/verify" => {
                let form = form(headers, body, &["csrf_token", "totp"])?;
                consume_csrf(
                    inner,
                    &session,
                    "factor_verify",
                    required(&form, "csrf_token")?,
                    now,
                )?;
                ensure!(
                    inner.stored.totp_secret.is_none(),
                    "factor_already_enrolled"
                );
                self.factor_budget(inner, peer)?;
                let (secret, expires) = inner
                    .sessions
                    .get(&session)
                    .and_then(|s| s.enrollment.clone())
                    .ok_or_else(|| anyhow!("invalid_enrollment"))?;
                ensure!(expires > now, "invalid_enrollment");
                let step = verify_totp(&secret, required(&form, "totp")?, now, None)?;
                let mut next = inner.stored.clone();
                next.totp_secret = Some(secret);
                next.last_totp_step = Some(step);
                self.commit(inner, next)?;
                // Keep the verifying owner, invalidate peers that never verified this factor.
                inner.sessions.retain(|id, _| id == &session);
                inner.csrf.clear();
                redirect(OWNER)
            }
            _ => bail!("invalid_request"),
        }
    }

    fn continuation(&self, inner: &Inner, args: &BTreeMap<String, String>) -> Result<String> {
        if args.is_empty() {
            return Ok(String::new());
        }
        let client = required(args, "client_id")?;
        let uri = required(args, "request_uri")?;
        ensure!(
            inner.pending.get(uri).is_some_and(|p| p.client == client),
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
        // Cookie parsing rejects ambiguous duplicated credentials.
        let mut found = None;
        for cookie in headers.get_all(header::COOKIE) {
            for pair in cookie.to_str()?.split(';') {
                if let Some((key, value)) = pair.trim().split_once('=') {
                    if key == COOKIE {
                        ensure!(found.is_none() && value.len() <= 256, "invalid_session");
                        found = Some(hash(value));
                    }
                }
            }
        }
        let id = found.ok_or_else(|| anyhow!("owner_login_required"))?;
        ensure!(
            inner
                .sessions
                .get(&id)
                .or_else(|| if owner {
                    None
                } else {
                    inner.anonymous.get(&id)
                })
                .is_some_and(|s| s.expires > self.now()
                    && (!owner || s.owner)
                    && self
                        .request_origin(headers)
                        .is_ok_and(|origin| origin == s.origin)),
            "owner_login_required"
        );
        Ok(id)
    }
    fn session(
        &self,
        inner: &mut Inner,
        headers: &HeaderMap,
        owner: bool,
    ) -> Result<(String, Option<String>)> {
        if let Ok(id) = self.session_id(inner, headers, owner) {
            return Ok((id, None));
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
        inner.anonymous.insert(
            id.clone(),
            Session {
                origin: self.request_origin(headers)?,
                owner: false,
                expires: self.now() + 600,
                enrollment: None,
            },
        );
        Ok((id, Some(token)))
    }
    fn secure_cookie(&self, origin: &str) -> &str {
        if origin.starts_with("https:") {
            "; Secure"
        } else {
            ""
        }
    }
    fn with_cookie(
        &self,
        mut response: Response,
        cookie: Option<String>,
        origin: &str,
    ) -> Response {
        if let Some(cookie) = cookie {
            response.headers_mut().insert(header::SET_COOKIE,HeaderValue::from_str(&format!("{COOKIE}={cookie}; Path=/agent-connect; HttpOnly; SameSite=Lax; Max-Age=43200{}",self.secure_cookie(origin))).unwrap());
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
        .map(|info| info.0.ip())
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    let path = parts.uri.path().to_string();
    let query = parts.uri.query().unwrap_or("").to_string();
    let origin = parts
        .headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let is_owner = path.starts_with(OWNER) || path == AUTHORIZE;
    let result = if permit.is_err() {
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
            Err(_) => Err(anyhow!("invalid_request")),
        }
    };
    let mut response = result.unwrap_or_else(|error| {
        let message = error.to_string();
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
            "invalid_csrf",
            "invalid_owner_origin",
        ]
        .contains(&message.as_str())
        {
            StatusCode::FORBIDDEN
        } else if message == "invalid_credentials" {
            StatusCode::UNAUTHORIZED
        } else if message.ends_with("rate_limited") || message == "slow_down" {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::BAD_REQUEST
        };
        if is_owner {
            owner_error(status, &message, &path)
        } else {
            json_response(status, json!({"error":code}))
        }
    });
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
fn profile_description(profile: PermissionProfile, harness: Harness) -> &'static str {
    match profile {
        PermissionProfile::Sandboxed => {
            "Allows native tools within the disposable box and all approved application tools. Shared harness login and transcripts remain readable."
        }
        PermissionProfile::ReadOnly => {
            "Codex read-only mode restricts native writes. Native reads and effects of approved application tools remain allowed; unexpected permission requests are denied."
        }
        PermissionProfile::DenyAll if harness == Harness::Claude => {
            "Denies Claude permission requests. Native actions that do not request permission may still run; this is not a guarantee of native-tool denial."
        }
        PermissionProfile::AppToolsOnly if harness == Harness::Claude => {
            "Allows permission requests attributed to approved application tools; denies other requests. Attribution depends on the adapter, and native actions without requests may still run."
        }
        PermissionProfile::DenyAll => {
            "Denies all permission requests. Native actions that do not request permission may still run."
        }
        PermissionProfile::AppToolsOnly => {
            "Allows only permission requests attributed to approved application tools. Native actions without requests may still run."
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
// Fixed styles are authorized by their SHA-256 CSP hash, never unsafe-inline.
const PAGE_STYLES: &str = r#":root{color-scheme:light;--ground:#f4f5f2;--paper:#fff;--ink:#202d2c;--muted:#566463;--line:#d7dfdb;--accent:#205e58;--soft:#edf5f1;--danger:#a52e27;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink)}a{color:var(--accent);text-underline-offset:.18em}.page{max-width:64rem;margin:0 auto;padding:clamp(1rem,4vw,3rem)}.page--compact{max-width:40rem}.brand{display:flex;align-items:center;gap:.6rem;font-weight:750;letter-spacing:-.025em;margin:0 0 1.2rem}.brand-mark{width:.65rem;height:.65rem;border-radius:50%;background:#ce7849;box-shadow:.9rem 0 var(--accent),1.8rem 0 #7861ad;margin-right:1.9rem}.surface{background:var(--paper);border:1px solid var(--line);border-radius:1rem;padding:clamp(1.25rem,4vw,2.5rem);box-shadow:0 .6rem 2rem #202d2c08}.compact{max-width:32rem;margin:auto}.eyebrow{margin:0 0 .35rem;color:var(--accent);font-size:.8rem;font-weight:750;letter-spacing:.07em;text-transform:uppercase}h1,h2,h3{overflow-wrap:anywhere}h1{margin:0;font-size:clamp(1.8rem,5vw,2rem);line-height:1.2;letter-spacing:-.035em}h2{margin:0;font-size:1.15rem;line-height:1.35}h3{margin:0;font-size:1rem}.lede{margin:.75rem 0 1.75rem;color:var(--muted);max-width:65ch}.help{color:var(--muted);font-size:.9rem;margin:.4rem 0 0}.field{display:grid;gap:.45rem;margin:1.4rem 0}.field label{font-weight:650}input,select,button{font:inherit}input,select{width:100%;min-height:3rem;padding:.7rem .85rem;border:1px solid #97a9a3;border-radius:.55rem;background:var(--paper);color:var(--ink)}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:2.9rem;padding:.65rem 1rem;border:1px solid transparent;border-radius:.55rem;background:var(--accent);color:white;font-weight:700;cursor:pointer;text-decoration:none}button:hover,.button:hover{background:#174a44}.secondary{background:white;color:var(--ink);border-color:#97a9a3}.secondary:hover{background:var(--ground)}.danger{background:white;color:var(--danger);border-color:#d5aaa5}.danger:hover{background:#fff0ec}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible,pre:focus-visible{outline:3px solid #8062b7;outline-offset:3px}.actions{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;flex-wrap:wrap;margin:1.4rem 0 0}.origin{overflow-wrap:anywhere;word-break:break-word}.origin-box{display:grid;gap:.35rem;background:var(--soft);border:1px solid #cfdfd6;border-radius:.6rem;padding:1rem;margin:1.5rem 0}.origin-box code{overflow-wrap:anywhere;letter-spacing:.05em}.notice{background:#fff8ec;border-left:3px solid #b48435;border-radius:.35rem;padding:1rem 1.2rem;margin:1.6rem 0;font-size:.9rem}.notice p:last-child{margin-bottom:0}.tool{margin:.8rem 0;padding:1rem;border:1px solid var(--line);border-radius:.6rem}.tool p{margin:.4rem 0 .7rem;overflow-wrap:anywhere}.tool h3 code{font-size:.95rem}summary{min-height:2.75rem;padding-block:.4rem;cursor:pointer;font-weight:650;color:var(--accent)}pre{overflow:auto;max-height:28rem;padding:.85rem;background:var(--ground);border-radius:.4rem;font: .85rem/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2}.management{margin-top:1.3rem;border:1px solid var(--line);border-radius:.65rem;overflow:hidden}.management>header{padding:1rem 1.2rem;background:#f7f9f6;border-bottom:1px solid var(--line)}.record{padding:1.1rem 1.2rem}.record+.record{border-top:1px solid var(--line)}.record-heading,.page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.page-heading .lede{margin-bottom:0}.counts{display:flex;border:1px solid var(--line);border-radius:.55rem;flex-shrink:0}.counts span{display:grid;padding:.6rem 1rem;font-size:.8rem;color:var(--muted)}.counts span+span{border-left:1px solid var(--line)}.counts strong{font-size:1.25rem;color:var(--ink);font-variant-numeric:tabular-nums}.status{font-size:.8rem;font-weight:750;white-space:nowrap;padding:.2rem .6rem;border-radius:2rem}.active{background:#e8f4ec;color:#22643e}.pending{background:#fff4d9;color:#785513}.inactive{background:var(--ground);color:var(--muted)}.authority{margin-top:.8rem}.empty{margin:1rem;padding:1rem;border-radius:.5rem;background:var(--ground)}.empty p{margin:.35rem 0 0;color:var(--muted)}.alert{border:1px solid #e5bfb6;border-radius:.6rem;background:#fff1eb;color:#823c2c;padding:1rem;margin:1rem 0}.alert p{margin:.4rem 0 0}.footer-note{text-align:center;color:var(--muted);font-size:.8rem;margin:1rem 0 0}time{font-variant-numeric:tabular-nums}@media(max-width:600px){.page{padding:1rem}.surface{padding:1.15rem;border-radius:.7rem}.page-heading,.record-heading{flex-direction:column;gap:.7rem}.counts{width:100%}.counts span{flex:1}.actions{display:grid;grid-template-columns:1fr}.actions form,button,.button{width:100%}.record,.management>header{padding:1rem}.status{align-self:flex-start}h1{font-size:1.8rem}}
"#;

fn page_csp(client: Option<&str>) -> String {
    let digest =
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(PAGE_STYLES.as_bytes()));
    format!(
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'{}; style-src 'sha256-{digest}'",
        client
            .map(|origin| format!(" {origin}"))
            .unwrap_or_default()
    )
}

fn html(body: &str) -> Response {
    let page_class = if body.starts_with("<div class='compact'>") {
        "page page--compact"
    } else {
        "page"
    };
    Response::builder().header(header::CONTENT_TYPE,"text/html; charset=utf-8")
        .header("content-security-policy",page_csp(None))
        .body(Body::from(format!("<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='color-scheme' content='light'><title>Agent Connect · Owner access</title><style>{PAGE_STYLES}</style></head><body><main class='{page_class}'><p class='brand'><span class='brand-mark' aria-hidden='true'></span>Agent Connect</p><section class='surface'>{body}</section><p class='footer-note'>This authorization surface is served by your own gateway.</p></main></body></html>"))).unwrap()
}

fn tool_cards(tools: &[Tool]) -> String {
    tools.iter().map(|tool|format!("<article class='tool'><h3><code>{}</code></h3><p>{}</p><details><summary>View exact input schema</summary><pre tabindex='0' role='region' aria-label='Input schema for {}'>{}</pre></details></article>",escape(&tool.name),escape(&tool.description),escape(&tool.name),escape(&serde_json::to_string_pretty(&tool.schema).expect("serializable schema")))).collect()
}

fn owner_error(status: StatusCode, reason: &str, path: &str) -> Response {
    let (title, message) = match reason {
        "invalid_credentials" => (
            "Sign-in did not complete",
            "The owner passphrase was not accepted. Try again with the passphrase you chose during setup.",
        ),
        "invalid_factor" => (
            "Authenticator code not accepted",
            "Enter a fresh six-digit code from your enrolled authenticator. A code already used for sign-in or approval cannot be reused.",
        ),
        "owner_login_required" | "invalid_session" => (
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
            "Enrollment expired",
            "Create a new enrollment secret from the owner console and confirm it within 10 minutes.",
        ),
        "factor_already_enrolled" => (
            "Authenticator already enrolled",
            "An authenticator is already enrolled for this gateway. Use it for owner sign-in and access approval.",
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
    let (target, label) =
        if path == LOGIN || matches!(reason, "owner_login_required" | "invalid_session") {
            (LOGIN, "Return to sign-in")
        } else {
            (OWNER, "Return to owner console")
        };
    let mut response = html(&format!(
        "<div class='compact'><p class='eyebrow'>Owner access</p><h1>{}</h1><div class='alert' role='alert'><p>{}</p></div><p class='help'>Return through the link below to load a fresh form. Submitted passphrases, codes and application data are never shown here.</p><div class='actions'><a class='button' href='{target}'>{label}</a></div></div>",
        escape(title),
        escape(message)
    ));
    *response.status_mut() = status;
    response
}

fn duration_label(seconds: u64) -> String {
    let (value, unit) = if seconds >= 86400 {
        (seconds / 86400, "day")
    } else if seconds >= 3600 {
        (seconds / 3600, "hour")
    } else if seconds >= 60 {
        (seconds / 60, "minute")
    } else {
        return "less than 1 minute".into();
    };
    format!("{value} {unit}{}", if value == 1 { "" } else { "s" })
}

fn utc_time(seconds: u64) -> String {
    // Gregorian civil-date conversion keeps presentation independent of locale
    // and local machine timezone, without adding a date library dependency.
    let days = (seconds / 86400) as i64 + 719468;
    let era = (if days >= 0 { days } else { days - 146096 }) / 146097;
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = seconds % 86400 / 3600;
    let minute = seconds % 3600 / 60;
    let second = seconds % 60;
    format!(
        "<time datetime='{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z'>{year:04}-{month:02}-{day:02} {hour:02}:{minute:02} UTC</time>"
    )
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

#[cfg(test)]
mod tests;

fn attempt_budget(
    budgets: &mut HashMap<IpAddr, AttemptBudget>,
    peer: IpAddr,
    now: u64,
    period: u64,
    limit: u32,
    error: &str,
) -> Result<()> {
    budgets.retain(|_, budget| now.saturating_sub(budget.window) < period);
    if budgets.len() >= 1024 && !budgets.contains_key(&peer) {
        if let Some(oldest) = budgets
            .iter()
            .min_by_key(|(_, b)| b.window)
            .map(|(ip, _)| *ip)
        {
            budgets.remove(&oldest);
        }
    }
    let budget = budgets.entry(peer).or_insert(AttemptBudget {
        window: now,
        count: 0,
    });
    ensure!(budget.count < limit, "{error}");
    budget.count += 1;
    Ok(())
}
