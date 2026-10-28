use super::*;
use tower::ServiceExt;

const APP: &str = "https://app.example";
const ISSUER: &str = "https://gateway.example";
const PASSWORD: &str = "test owner passphrase";
const VERIFIER: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

struct Fixture {
    dir: PathBuf,
    auth: Arc<AuthService>,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(random("agent-connect-auth-test-"));
        let auth = AuthService::open(config(dir.clone(), Some(PASSWORD))).unwrap();
        Self { dir, auth }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn config(dir: PathBuf, password: Option<&str>) -> AuthConfig {
    AuthConfig {
        public_url: ISSUER.into(),
        state_dir: dir,
        policy_fingerprint: "policy-1".into(),
        entry_points: Vec::new(),
        profiles: vec![PermissionProfile::Sandboxed],
        default_profile: PermissionProfile::Sandboxed,
        harness: Harness::Codex,
        owner_passphrase: password.map(str::to_string),
    }
}
struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    text: String,
}
impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap()
    }
}
async fn request(
    auth: &Arc<AuthService>,
    method: Method,
    path: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
    fields: &[(&str, &str)],
) -> Reply {
    request_at(auth, method, path, origin, cookie, None, fields).await
}
async fn request_at(
    auth: &Arc<AuthService>,
    method: Method,
    path: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
    host: Option<&str>,
    fields: &[(&str, &str)],
) -> Reply {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if let Some(host) = host {
        builder = builder.header(header::HOST, host);
    }
    if let Some(origin) = origin {
        builder = builder.header("origin", origin);
    }
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let response = auth
        .clone()
        .router()
        .oneshot(
            builder
                .body(Body::from(serde_urlencoded::to_string(fields).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    Reply {
        status: parts.status,
        headers: parts.headers,
        text: String::from_utf8(to_bytes(body, MAX_BODY).await.unwrap().to_vec()).unwrap(),
    }
}
fn input(text: &str, name: &str) -> String {
    let marker = format!("name='{name}' value='");
    let value = text
        .split(&marker)
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    value
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}
fn enrollment_secret(text: &str) -> String {
    let href = text
        .split("href='otpauth://")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    let uri = Url::parse(&format!("otpauth://{}", href.replace("&amp;", "&"))).unwrap();
    uri.query_pairs()
        .find(|(key, _)| key == "secret")
        .unwrap()
        .1
        .into_owned()
}

fn assert_style_hashes(page: &Reply, count: usize) {
    let styles: Vec<_> = page
        .text
        .split("<style>")
        .skip(1)
        .map(|style| style.split("</style>").next().unwrap())
        .collect();
    assert_eq!(styles.len(), count);
    let policy = page.headers["content-security-policy"].to_str().unwrap();
    for style in styles {
        let digest =
            base64::engine::general_purpose::STANDARD.encode(Sha256::digest(style.as_bytes()));
        assert!(policy.contains(&format!("'sha256-{digest}'")));
    }
    assert_eq!(policy.matches("'sha256-").count(), count);
    assert!(!policy.contains("unsafe-inline"));
}

fn cookie(reply: &Reply) -> String {
    reply.headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}
fn advance(auth: &Arc<AuthService>, seconds: u64) {
    auth.clock
        .fetch_add(seconds, std::sync::atomic::Ordering::Relaxed);
}
async fn login(auth: &Arc<AuthService>, factor: &str) -> String {
    let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
    let response = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&cookie(&page)),
        &[
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("continue", ""),
            ("passphrase", PASSWORD),
            ("totp", factor),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::FOUND, "{}", response.text);
    cookie(&response)
}
async fn pushed(auth: &Arc<AuthService>) -> String {
    let details=json!([{"type":"agent_connect","tools":[{"name":"read_book","description":"Read <script>alert('app')</script>","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}}]}]).to_string();
    let challenge = hash(VERIFIER);
    let response = request(
        auth,
        Method::POST,
        PAR,
        Some(APP),
        None,
        &[
            ("client_id", APP),
            ("client_name", "Books <app>"),
            (
                "redirect_uri",
                "https://app.example/callback?keep=1&state=spoof",
            ),
            ("resource", "https://gateway.example/acp"),
            ("response_type", "code"),
            ("scope", "acp"),
            ("state", "application-state"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("authorization_details", &details),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json()["request_uri"].as_str().unwrap().to_string()
}
async fn consent(
    auth: &Arc<AuthService>,
    owner: &str,
    uri: &str,
    decision: &str,
    factor: &str,
    duration: &str,
) -> Reply {
    let page = request(
        auth,
        Method::GET,
        &authorize_url(APP, uri),
        None,
        Some(owner),
        &[],
    )
    .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    request(
        auth,
        Method::POST,
        AUTHORIZE,
        Some(ISSUER),
        Some(owner),
        &[
            ("request_uri", uri),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("decision", decision),
            ("duration", duration),
            ("totp", factor),
            ("profile", "sandboxed"),
        ],
    )
    .await
}
fn code(reply: &Reply) -> String {
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let url = Url::parse(reply.headers[header::LOCATION].to_str().unwrap()).unwrap();
    assert_eq!(url.origin().ascii_serialization(), APP);
    assert_eq!(url.query_pairs().filter(|(k, _)| k == "state").count(), 1);
    assert_eq!(
        url.query_pairs().find(|(k, _)| k == "state").unwrap().1,
        "application-state"
    );
    assert_eq!(
        url.query_pairs().find(|(k, _)| k == "iss").unwrap().1,
        ISSUER
    );
    url.query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .to_string()
}
async fn exchange(auth: &Arc<AuthService>, code: &str, verifier: &str, origin: &str) -> Reply {
    request(
        auth,
        Method::POST,
        TOKEN,
        Some(origin),
        None,
        &[
            ("client_id", APP),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            (
                "redirect_uri",
                "https://app.example/callback?keep=1&state=spoof",
            ),
            ("resource", "https://gateway.example/acp"),
        ],
    )
    .await
}
async fn refresh(auth: &Arc<AuthService>, token: &str) -> Reply {
    request(
        auth,
        Method::POST,
        TOKEN,
        Some(APP),
        None,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", token),
            ("client_id", APP),
            ("resource", "https://gateway.example/acp"),
        ],
    )
    .await
}
async fn pair(auth: &Arc<AuthService>, owner: &str, duration: &str) -> Value {
    let uri = pushed(auth).await;
    let callback = consent(auth, owner, &uri, "approve", "", duration).await;
    let response = exchange(auth, &code(&callback), VERIFIER, APP).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json()
}

#[tokio::test]
async fn complete_grant_rotation_reuse_revocation_and_exact_snapshot() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let tokens = pair(auth, &owner, "3600").await;
    assert_eq!(tokens["expires_in"], 300);
    assert_eq!(tokens["refresh_token_expires_in"], 3600);
    assert_eq!(tokens["gateway_url"], "wss://gateway.example/acp");
    let bearer = tokens["access_token"].as_str().unwrap();
    let principal = auth.authenticate(bearer, APP).unwrap();
    assert!(auth.recheck(&principal));
    assert!(auth.is_grant_active(&principal.id));
    assert_eq!(principal.snapshot["read_book"]["required"], json!(["id"]));
    assert!(auth.authenticate(bearer, "https://other.example").is_err());
    assert!(auth.authenticate(bearer, "https://APP.example").is_err());
    assert!(auth.authenticate(bearer, "").is_err());
    let next = refresh(auth, tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(next.status, StatusCode::OK);
    let next = next.json();
    assert_eq!(next["grant_id"], tokens["grant_id"]);
    assert_ne!(next["access_token"], tokens["access_token"]);
    assert!(!auth.recheck(&principal));
    assert!(auth.is_grant_active(&principal.id));
    let current = auth
        .authenticate(next["access_token"].as_str().unwrap(), APP)
        .unwrap();
    let reused = refresh(auth, tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(reused.status, StatusCode::BAD_REQUEST);
    assert_eq!(reused.json()["error"], "invalid_grant");
    assert!(!auth.recheck(&current));
    assert!(!auth.is_grant_active(&principal.id));
    assert!(
        auth.authenticate(next["access_token"].as_str().unwrap(), APP)
            .is_err()
    );
}

#[tokio::test]
async fn code_origin_pkce_denial_and_replay() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    let denied = consent(auth, &owner, &uri, "deny", "", "3600").await;
    let location = Url::parse(denied.headers[header::LOCATION].to_str().unwrap()).unwrap();
    assert_eq!(
        location
            .query_pairs()
            .find(|(k, _)| k == "error")
            .unwrap()
            .1,
        "access_denied"
    );
    assert!(auth.inner.lock().unwrap().stored.grants.is_empty());
    assert_eq!(
        request(
            auth,
            Method::GET,
            &authorize_url(APP, &uri),
            None,
            Some(&owner),
            &[]
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let uri = pushed(auth).await;
    let callback = consent(auth, &owner, &uri, "approve", "", "3600").await;
    let code = code(&callback);
    assert_eq!(
        exchange(auth, &code, VERIFIER, "https://other.example")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        exchange(auth, &code, "wrong verifier", APP).await.json()["error"],
        "invalid_grant"
    );
    assert_eq!(
        exchange(auth, &code, VERIFIER, APP).await.status,
        StatusCode::OK
    );
    assert_eq!(
        exchange(auth, &code, VERIFIER, APP).await.json()["error"],
        "invalid_grant"
    );
    assert_eq!(
        request(auth, Method::POST, TOKEN, None, None, &[("client_id", APP)])
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn transient_access_and_owner_selected_grant_expiry() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    advance(auth, REQUEST_TTL);
    assert_eq!(
        request(
            auth,
            Method::GET,
            &authorize_url(APP, &uri),
            None,
            Some(&owner),
            &[]
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let uri = pushed(auth).await;
    let callback = consent(auth, &owner, &uri, "approve", "", "3600").await;
    advance(auth, CODE_TTL);
    assert_eq!(
        exchange(auth, &code(&callback), VERIFIER, APP).await.json()["error"],
        "invalid_grant"
    );
    let tokens = pair(auth, &owner, "3600").await;
    let principal = auth
        .authenticate(tokens["access_token"].as_str().unwrap(), APP)
        .unwrap();
    advance(auth, ACCESS_TTL);
    assert!(!auth.recheck(&principal));
    assert!(auth.is_grant_active(&principal.id));
    assert!(
        auth.authenticate(tokens["access_token"].as_str().unwrap(), APP)
            .is_err()
    );
    let rotated = refresh(auth, tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(rotated.status, StatusCode::OK);
    advance(auth, 3600);
    assert!(!auth.is_grant_active(&principal.id));
    assert_eq!(
        refresh(auth, rotated.json()["refresh_token"].as_str().unwrap())
            .await
            .json()["error"],
        "invalid_grant"
    );
    let tokens = pair(auth, &owner, "60").await;
    assert_eq!(tokens["expires_in"], 60);
    advance(auth, 60);
    assert!(
        auth.authenticate(tokens["access_token"].as_str().unwrap(), APP)
            .is_err()
    );
    let uri = pushed(auth).await;
    assert_eq!(
        consent(auth, &owner, &uri, "approve", "", "2592001")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn owner_csrf_clickjacking_escaped_consent_and_bearer_separation() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    let page = request(
        auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        Some(&owner),
        &[],
    )
    .await;
    assert!(!page.text.contains("<script>"));
    assert!(page.text.contains("&lt;script&gt;"));
    assert!(page.text.contains("Books &lt;app&gt;"));
    assert_eq!(page.headers["x-frame-options"], "DENY");
    assert_eq!(page.headers["cache-control"], "no-store");
    assert_eq!(page.headers["referrer-policy"], "same-origin");
    assert!(
        page.headers["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    assert!(
        page.headers["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("form-action 'self' https://app.example")
    );
    let token = input(&page.text, "csrf_token");
    let fields = [
        ("request_uri", uri.as_str()),
        ("csrf_token", token.as_str()),
        ("decision", "approve"),
        ("duration", "3600"),
    ];
    let denied = request(auth, Method::POST, AUTHORIZE, Some(ISSUER), None, &fields).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    let cross = request(
        auth,
        Method::POST,
        AUTHORIZE,
        Some(APP),
        Some(&owner),
        &fields,
    )
    .await;
    assert_eq!(cross.status, StatusCode::FORBIDDEN);
    let callback = request(
        auth,
        Method::POST,
        AUTHORIZE,
        Some(ISSUER),
        Some(&owner),
        &fields,
    )
    .await;
    assert_eq!(callback.status, StatusCode::FOUND);
    assert_eq!(
        request(
            auth,
            Method::POST,
            AUTHORIZE,
            Some(ISSUER),
            Some(&owner),
            &fields
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    let tokens = exchange(auth, &code(&callback), VERIFIER, APP).await.json();
    let bearer = tokens["access_token"].as_str().unwrap();
    let response = auth
        .clone()
        .router()
        .oneshot(
            axum::http::Request::builder()
                .uri(OWNER)
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(response.headers()[header::LOCATION], LOGIN);
    let login_page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
    let set = login_page.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(set.contains("HttpOnly"));
    assert!(set.contains("SameSite=Lax"));
    assert!(set.contains("Secure"));
    assert_eq!(
        request(
            auth,
            Method::GET,
            &format!("{LOGIN}?continue=https%3A%2F%2Fevil.example"),
            None,
            None,
            &[]
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            auth,
            Method::GET,
            &format!("{LOGIN}?client_id={APP}&request_uri=missing"),
            None,
            None,
            &[]
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn logout_owner_and_application_revocation_are_durable() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let tokens = pair(auth, &owner, "3600").await;
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    let revoke_csrf = form_token(&page.text, "/agent-connect/owner/grants/revoke");
    assert_eq!(
        request(
            auth,
            Method::POST,
            "/agent-connect/owner/grants/revoke",
            Some(ISSUER),
            Some(&owner),
            &[
                ("csrf_token", &revoke_csrf),
                ("grant_id", tokens["grant_id"].as_str().unwrap())
            ]
        )
        .await
        .status,
        StatusCode::FOUND
    );
    assert!(!auth.is_grant_active(tokens["grant_id"].as_str().unwrap()));
    let tokens = pair(auth, &owner, "3600").await;
    let response = request(
        auth,
        Method::POST,
        REVOKE,
        Some(APP),
        None,
        &[
            ("client_id", APP),
            ("token", tokens["access_token"].as_str().unwrap()),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(!auth.is_grant_active(tokens["grant_id"].as_str().unwrap()));
    assert_eq!(
        request(
            auth,
            Method::POST,
            REVOKE,
            Some(APP),
            None,
            &[("client_id", APP), ("token", "unknown")]
        )
        .await
        .status,
        StatusCode::OK
    );
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    let marker = page
        .text
        .rsplit("action='/agent-connect/owner/logout'>")
        .next()
        .unwrap();
    let token = input(marker, "csrf_token");
    let response = request(
        auth,
        Method::POST,
        "/agent-connect/owner/logout",
        Some(ISSUER),
        Some(&owner),
        &[("csrf_token", &token)],
    )
    .await;
    assert_eq!(response.status, StatusCode::FOUND);
    assert!(
        response.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::FOUND
    );
}

#[tokio::test]
async fn restart_preserves_hashed_tokens_policy_drift_fails_closed() {
    let dir = std::env::temp_dir().join(random("agent-connect-auth-restart-test-"));
    let auth = AuthService::open(config(dir.clone(), Some(PASSWORD))).unwrap();
    let owner = login(&auth, "").await;
    let tokens = pair(&auth, &owner, "3600").await;
    let serialized = fs::read_to_string(dir.join("authorization.json")).unwrap();
    assert!(!serialized.contains(PASSWORD));
    assert!(!serialized.contains(tokens["access_token"].as_str().unwrap()));
    assert!(!serialized.contains(tokens["refresh_token"].as_str().unwrap()));
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(dir.join("authorization.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o077,
        0
    );
    assert!(AuthService::open(config(dir.clone(), None)).is_err());
    drop(auth);
    let auth = AuthService::open(config(dir.clone(), None)).unwrap();
    assert!(
        auth.authenticate(tokens["access_token"].as_str().unwrap(), APP)
            .is_ok()
    );
    let refresh_response = refresh(&auth, tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(refresh_response.status, StatusCode::OK);
    assert_eq!(
        request(&auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::FOUND
    );
    drop(auth);
    let mut changed = config(dir.clone(), None);
    changed.policy_fingerprint = "policy-2".into();
    let auth = AuthService::open(changed).unwrap();
    assert!(
        auth.authenticate(
            refresh_response.json()["access_token"].as_str().unwrap(),
            APP
        )
        .is_err()
    );
    assert_eq!(
        refresh(
            &auth,
            refresh_response.json()["refresh_token"].as_str().unwrap()
        )
        .await
        .json()["error"],
        "invalid_grant"
    );
    drop(auth);
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn persistence_failure_disables_every_existing_grant() {
    let fixture = Fixture::new();
    let owner = login(&fixture.auth, "").await;
    let tokens = pair(&fixture.auth, &owner, "3600").await;
    let principal = fixture
        .auth
        .authenticate(tokens["access_token"].as_str().unwrap(), APP)
        .unwrap();
    assert!(fixture.auth.healthy());
    let backup = fixture.dir.with_extension("backup");
    fs::rename(&fixture.dir, &backup).unwrap();
    fs::write(&fixture.dir, b"cannot persist").unwrap();
    let response = refresh(&fixture.auth, tokens["refresh_token"].as_str().unwrap()).await;
    assert_ne!(response.status, StatusCode::OK);
    assert!(!fixture.auth.healthy());
    assert!(!response.text.contains("access_token"));
    assert!(!fixture.auth.recheck(&principal));
    assert!(!fixture.auth.is_grant_active(&principal.id));
    assert!(
        fixture
            .auth
            .authenticate(tokens["access_token"].as_str().unwrap(), APP)
            .is_err()
    );
    assert_eq!(
        request(&fixture.auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::SERVICE_UNAVAILABLE
    );
    fs::remove_file(&fixture.dir).unwrap();
    fs::rename(backup, &fixture.dir).unwrap();
}

#[tokio::test]
async fn authenticator_enrollment_login_approval_and_replay() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let page = request(auth, Method::GET, pages::TOTP, None, Some(&owner), &[]).await;
    let csrf = input(&page.text, "csrf_token");
    let page = request(
        auth,
        Method::POST,
        "/agent-connect/owner/totp/enroll",
        Some(ISSUER),
        Some(&owner),
        &[("csrf_token", &csrf), ("passphrase", PASSWORD)],
    )
    .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    assert!(page.text.contains("<svg viewBox="));
    assert!(page.text.contains("role='img' aria-label='QR code"));
    let script = page
        .text
        .split("<script>")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    let digest =
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(script.as_bytes()));
    let policy = page.headers["content-security-policy"].to_str().unwrap();
    assert!(policy.contains(&format!("script-src 'sha256-{digest}'")));
    assert!(!policy.contains("unsafe-inline"));
    assert!(
        page.text
            .contains("class='copy-status' role='status' aria-live='polite'")
    );
    let secret = enrollment_secret(&page.text);
    assert_eq!(decode_secret(&secret).unwrap().len(), 20);
    let factor = totp(&secret, auth.now() / 30).unwrap();
    let response = request(
        auth,
        Method::POST,
        "/agent-connect/owner/totp/verify",
        Some(ISSUER),
        Some(&owner),
        &[
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("totp", &factor),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::FOUND);
    assert_eq!(response.headers["location"], pages::SECURITY);
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::OK
    );
    let uri = pushed(auth).await;
    assert_eq!(
        consent(auth, &owner, &uri, "approve", &factor, "3600")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    advance(auth, 30);
    let factor = totp(&secret, auth.now() / 30).unwrap();
    let callback = consent(auth, &owner, &uri, "approve", &factor, "3600").await;
    assert_eq!(callback.status, StatusCode::FOUND);
    // The approval code cannot be reused for another owner login.
    let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
    let rejected = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&cookie(&page)),
        &[
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("continue", ""),
            ("passphrase", PASSWORD),
            ("totp", &factor),
        ],
    )
    .await;
    assert_eq!(rejected.status, StatusCode::BAD_REQUEST);
    advance(auth, 30);
    let factor = totp(&secret, auth.now() / 30).unwrap();
    let _ = login(auth, &factor).await;
    // Factor secret is persisted only in private gateway state, never app responses.
    assert!(
        !exchange(auth, &code(&callback), VERIFIER, APP)
            .await
            .text
            .contains(&secret)
    );
}

#[test]
fn totp_rfc_vector_and_origin_tool_validation() {
    let secret = base32(b"12345678901234567890");
    assert_eq!(totp(&secret, 59 / 30).unwrap(), "287082");
    assert_eq!(verify_totp(&secret, "287082", 59, None).unwrap(), 1);
    assert!(verify_totp(&secret, "287082", 59, Some(1)).is_err());
    for origin in [
        "https://app.example",
        "http://localhost:1234",
        "http://127.0.0.1:1234",
        "http://[::1]:1234",
    ] {
        canonical_origin(origin).unwrap();
    }
    for origin in [
        "http://app.example",
        "https://app.example/",
        "https://APP.example",
        "https://app.example:443",
        "https://user@app.example",
        "https://app.example?x=1",
    ] {
        assert!(canonical_origin(origin).is_err(), "{origin}");
    }
    assert!(valid_redirect("https://evil.example/callback", APP).is_err());
    assert!(valid_redirect("https://app.example/callback#token", APP).is_err());
    assert!(fields(b"client_id=a&client_id=b", &["client_id"]).is_err());
    assert!(fields(b"unknown=a", &["client_id"]).is_err());
    assert!(validate_tools(&json!([])).is_err());
    assert!(validate_tools(&json!([{"name":"read","description":"Read","inputSchema":{}},{"name":"read","description":"Read again","inputSchema":{}}])).is_err());
    assert!(
        validate_tools(&json!([{"name":"read.invalid","description":"Read","inputSchema":{}}]))
            .is_err()
    );
    assert!(
        validate_tools(&json!([{"name":"read","description":"Read","inputSchema":[]}])).is_err()
    );
}

#[test]
fn bootstrap_requires_private_state_and_password() {
    let dir = std::env::temp_dir().join(random("agent-connect-bootstrap-test-"));
    assert!(AuthService::open(config(dir.clone(), None)).is_err());
    assert!(AuthService::open(config(dir.clone(), Some("short"))).is_err());
    assert!(AuthService::open(config(dir.clone(), Some("😀😀😀"))).is_err());
    let auth = AuthService::open(config(dir.clone(), Some(PASSWORD))).unwrap();
    drop(auth);
    fs::write(dir.join("authorization.json"), b"bad state").unwrap();
    assert!(AuthService::open(config(dir.clone(), Some(PASSWORD))).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn anonymous_flood_preserves_owner_session_and_csrf_capacity() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    let owner_csrf = input(&page.text, "csrf_token");
    for _ in 0..MAX_TRANSIENT + 1 {
        assert_eq!(
            request(auth, Method::GET, LOGIN, None, None, &[])
                .await
                .status,
            StatusCode::OK
        );
    }
    let inner = auth.inner.lock().unwrap();
    assert_eq!(inner.anonymous.len(), MAX_TRANSIENT);
    assert_eq!(inner.sessions.len(), 1);
    assert!(inner.csrf.contains_key(&hash(&owner_csrf)));
    drop(inner);
    let _second_owner = login(auth, "").await;
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::OK
    );
}

#[test]
fn peer_attempt_limits_are_independent_bounded_and_expire() {
    let first: IpAddr = "192.0.2.1".parse().unwrap();
    let other: IpAddr = "192.0.2.2".parse().unwrap();
    let mut budgets = HashMap::new();
    for _ in 0..10 {
        attempt_budget(&mut budgets, first, 1000, 900, 10, "login_rate_limited").unwrap();
    }
    assert!(attempt_budget(&mut budgets, first, 1000, 900, 10, "login_rate_limited").is_err());
    attempt_budget(&mut budgets, other, 1000, 900, 10, "login_rate_limited").unwrap();
    attempt_budget(&mut budgets, first, 1900, 900, 10, "login_rate_limited").unwrap();
    for index in 0..2048 {
        let peer = IpAddr::V4(std::net::Ipv4Addr::from(0xc000_0200u32 + index));
        attempt_budget(&mut budgets, peer, 1900, 900, 10, "login_rate_limited").unwrap();
    }
    assert_eq!(budgets.len(), 1024);
}

#[tokio::test]
async fn safe_pending_continuation_and_csrf_expiry() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let uri = pushed(auth).await;
    let redirect_page = request(
        auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        None,
        &[],
    )
    .await;
    assert_eq!(redirect_page.status, StatusCode::FOUND);
    let target = redirect_page.headers[header::LOCATION].to_str().unwrap();
    assert!(target.starts_with(LOGIN));
    let login_page = request(auth, Method::GET, target, None, None, &[]).await;
    let continuation = input(&login_page.text, "continue");
    assert_eq!(continuation, authorize_url(APP, &uri));
    let response = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&cookie(&login_page)),
        &[
            ("csrf_token", &input(&login_page.text, "csrf_token")),
            ("continue", &continuation),
            ("passphrase", PASSWORD),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::FOUND);
    assert_eq!(response.headers[header::LOCATION], continuation);
    assert_eq!(response.headers["referrer-policy"], "no-referrer");
    let owner = cookie(&response);
    let page = request(
        auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        Some(&owner),
        &[],
    )
    .await;
    advance(auth, 600);
    assert_eq!(
        request(
            auth,
            Method::POST,
            AUTHORIZE,
            Some(ISSUER),
            Some(&owner),
            &[
                ("request_uri", &uri),
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("decision", "approve"),
                ("duration", "3600")
            ]
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn owner_ui_has_labels_empty_states_and_hashed_styles() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
    assert!(
        page.text
            .contains("<label for='owner-passphrase'>Owner passphrase</label>")
    );
    assert!(
        page.text
            .contains("id='owner-passphrase' type=password name=passphrase")
    );
    assert!(page.text.contains("<main class='page page--compact'>"));
    let styles = page
        .text
        .split("<style>")
        .nth(1)
        .unwrap()
        .split("</style>")
        .next()
        .unwrap();
    let digest =
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(styles.as_bytes()));
    let policy = page.headers["content-security-policy"].to_str().unwrap();
    assert!(policy.contains(&format!("style-src 'sha256-{digest}'")));
    assert!(!policy.contains("unsafe-inline"));
    assert!(policy.contains("frame-ancestors 'none'"));
    assert!(styles.contains("@media (max-width:600px)"));
    assert!(styles.contains(":focus-visible"));
    assert!(styles.contains("overflow-wrap:anywhere"));
    let owner = login(auth, "").await;
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    assert!(page.text.contains("<main class='page'>"));
    assert!(page.text.contains("No apps yet"));
    assert!(page.text.contains("aria-label='Owner pages'"));
    assert!(page.text.contains("href='/agent-connect/owner/totp'"));
    let uri = pushed(auth).await;
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    assert!(page.text.contains("Books &lt;app&gt;"));
    assert!(page.text.contains(">Review</a>"));
    assert!(page.text.contains("request expires"));
    assert!(!page.text.contains("Unix seconds"));
    let page = request(
        auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        Some(&owner),
        &[],
    )
    .await;
    assert!(
        page.text
            .contains("role='region' aria-label='Input schema for read_book'")
    );
    assert!(page.text.contains("&lt;script&gt;"));
    assert!(page.text.contains("<legend>Access lasts</legend>"));
    assert_eq!(page.text.matches("type=radio name=duration").count(), 4);
    assert!(page.text.contains("type=radio name=profile"));
    assert!(!page.text.contains("<select"));
    let first_button = page
        .text
        .split("<button")
        .nth(1)
        .unwrap()
        .split("</button>")
        .next()
        .unwrap();
    assert!(first_button.contains("name=decision value=approve>Approve"));
    let policy = page.headers["content-security-policy"].to_str().unwrap();
    assert!(policy.contains("form-action 'self' https://app.example"));
    assert!(policy.contains("style-src 'sha256-"));
}

#[tokio::test]
async fn owner_post_errors_are_safe_html_and_api_errors_remain_json() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
    let response = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&cookie(&page)),
        &[
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("continue", ""),
            ("passphrase", "bad<script>private-password</script>"),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    assert!(response.text.contains("Sign-in did not complete"));
    assert!(response.text.contains("role='alert'"));
    assert!(response.text.contains(&format!("href='{LOGIN}'")));
    assert!(!response.text.contains("private-password"));
    assert!(!response.text.contains("<script>"));
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers["referrer-policy"], "same-origin");
    assert_eq!(response.headers["x-frame-options"], "DENY");
    assert!(
        response.headers["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    let response = request(
        auth,
        Method::POST,
        AUTHORIZE,
        Some(ISSUER),
        Some(&owner),
        &[
            ("request_uri", &uri),
            ("csrf_token", "expired<script>challenge</script>"),
            ("decision", "approve"),
            ("duration", "3600"),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert!(response.text.contains("Refresh this page to continue"));
    assert!(response.text.contains(&format!("href='{OWNER}'")));
    assert!(!response.text.contains("expired<script>"));
    // A fresh GET offers another valid challenge after the consumed/invalid form.
    assert_eq!(
        consent(auth, &owner, &uri, "deny", "", "3600").await.status,
        StatusCode::FOUND
    );
    let response = request(
        auth,
        Method::POST,
        TOKEN,
        Some(APP),
        None,
        &[
            ("client_id", APP),
            ("grant_type", "refresh_token"),
            ("refresh_token", "unknown"),
            ("resource", "https://gateway.example/acp"),
        ],
    )
    .await;
    assert_eq!(response.headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.json()["error"], "invalid_grant");
    assert_eq!(response.headers["referrer-policy"], "no-referrer");
}

fn sign_in_retry(reply: &Reply) -> String {
    reply
        .text
        .split("class='button wide' href='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap()
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
}

async fn pending_sign_in(auth: &Arc<AuthService>) -> (String, String, Reply) {
    let uri = pushed(auth).await;
    let response = request(
        auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        None,
        &[],
    )
    .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let target = response.headers[header::LOCATION]
        .to_str()
        .unwrap()
        .to_string();
    let page = request(auth, Method::GET, &target, None, None, &[]).await;
    assert_eq!(page.status, StatusCode::OK);
    (uri, target, page)
}

#[tokio::test]
async fn failed_sign_in_retries_original_consent_with_fresh_csrf() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let (uri, target, page) = pending_sign_in(auth).await;
    let anonymous = cookie(&page);
    let continuation = input(&page.text, "continue");
    let old_csrf = input(&page.text, "csrf_token");
    assert_eq!(continuation, authorize_url(APP, &uri));
    let failed = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&anonymous),
        &[
            ("continue", &continuation),
            ("csrf_token", &old_csrf),
            ("passphrase", "wrong passphrase"),
        ],
    )
    .await;
    assert_eq!(failed.status, StatusCode::UNAUTHORIZED);
    assert_eq!(sign_in_retry(&failed), target);
    assert!(!failed.headers.contains_key(header::SET_COOKIE));
    {
        let inner = auth.inner.lock().unwrap();
        assert!(inner.stored.grants.is_empty());
        assert!(inner.codes.is_empty());
        assert!(inner.sessions.is_empty());
        assert!(!inner.anonymous_csrf.contains_key(&hash(&old_csrf)));
    }
    let retry = request(
        auth,
        Method::GET,
        &sign_in_retry(&failed),
        None,
        Some(&anonymous),
        &[],
    )
    .await;
    assert_eq!(retry.status, StatusCode::OK);
    assert_eq!(input(&retry.text, "continue"), continuation);
    let fresh_csrf = input(&retry.text, "csrf_token");
    assert_ne!(fresh_csrf, old_csrf);
    let replay = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&anonymous),
        &[
            ("continue", &continuation),
            ("csrf_token", &old_csrf),
            ("passphrase", PASSWORD),
        ],
    )
    .await;
    assert_eq!(replay.status, StatusCode::FORBIDDEN);
    assert_eq!(sign_in_retry(&replay), LOGIN);
    let signed_in = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&anonymous),
        &[
            ("continue", &continuation),
            ("csrf_token", &fresh_csrf),
            ("passphrase", PASSWORD),
        ],
    )
    .await;
    assert_eq!(signed_in.status, StatusCode::FOUND);
    assert_eq!(signed_in.headers[header::LOCATION], continuation);
    assert!(auth.inner.lock().unwrap().stored.grants.is_empty());
    let approved = consent(auth, &cookie(&signed_in), &uri, "approve", "", "3600").await;
    assert!(!code(&approved).is_empty()); // Also verifies original app state and issuer.
    assert_eq!(auth.inner.lock().unwrap().stored.grants.len(), 1);
}

#[tokio::test]
async fn failed_sign_in_totp_persistence_error_keeps_unavailable_status_and_no_authority() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let secret = base32(&[9; 20]);
    {
        let mut inner = auth.inner.lock().unwrap();
        let mut next = inner.stored.clone();
        next.totp_secret = Some(secret.clone());
        next.last_totp_step = None;
        auth.commit(&mut inner, next).unwrap();
    }
    let (_, target, page) = pending_sign_in(auth).await;
    let anonymous = cookie(&page);
    let token = input(&page.text, "csrf_token");
    let factor = totp(&secret, auth.now() / 30).unwrap();
    assert!(verify_totp(&secret, &factor, auth.now(), None).is_ok());
    // Keep the original state inside the fixture, but make the atomic save's
    // destination a directory so even a privileged test runner cannot write it.
    let state = fixture.dir.join("authorization.json");
    let saved = fixture.dir.join("before-write-failure.json");
    fs::rename(&state, &saved).unwrap();
    fs::create_dir(&state).unwrap();
    let response = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&anonymous),
        &[
            ("continue", &input(&page.text, "continue")),
            ("csrf_token", &token),
            ("passphrase", PASSWORD),
            ("totp", &factor),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.headers[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
    assert!(response.text.contains("Authorization unavailable"));
    assert_eq!(sign_in_retry(&response), target);
    assert!(!response.headers.contains_key(header::SET_COOKIE));
    for private in [
        PASSWORD,
        secret.as_str(),
        factor.as_str(),
        anonymous.split_once('=').unwrap().1,
        fixture.dir.to_str().unwrap(),
        "authorization.json",
        ".authorization-",
        "os error",
        "Is a directory",
    ] {
        assert!(
            !response.text.contains(private),
            "Private failure details must not reach HTML"
        );
    }
    assert!(!auth.healthy()); // Reached the real persistence failure, not bad credentials.
    let inner = auth.inner.lock().unwrap();
    assert!(inner.sessions.is_empty());
    assert!(inner.stored.grants.is_empty());
    assert!(inner.codes.is_empty());
    assert!(inner.stored.last_totp_step.is_none());
    assert!(!inner.anonymous_csrf.contains_key(&hash(&token)));
    let persisted: Stored = serde_json::from_slice(&fs::read(saved).unwrap()).unwrap();
    assert!(persisted.last_totp_step.is_none());
}

#[tokio::test]
async fn failed_sign_in_factor_and_budgets_preserve_only_valid_retry() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let (_, target, initial) = pending_sign_in(auth).await;
    let anonymous = cookie(&initial);
    auth.inner.lock().unwrap().stored.totp_secret = Some(base32(&[9; 20]));
    let peer = IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED);
    for (login_count, factor_count, status, message) in [
        (
            0,
            0,
            StatusCode::BAD_REQUEST,
            "Authenticator code not accepted",
        ),
        (10, 0, StatusCode::TOO_MANY_REQUESTS, "Too many attempts"),
        (0, 5, StatusCode::TOO_MANY_REQUESTS, "Too many attempts"),
    ] {
        let page = request(auth, Method::GET, &target, None, Some(&anonymous), &[]).await;
        {
            let mut inner = auth.inner.lock().unwrap();
            inner.login_budgets.insert(
                peer,
                AttemptBudget {
                    window: auth.now(),
                    count: login_count,
                },
            );
            inner.factor_budgets.insert(
                peer,
                AttemptBudget {
                    window: auth.now(),
                    count: factor_count,
                },
            );
        }
        let token = input(&page.text, "csrf_token");
        let reply = request(
            auth,
            Method::POST,
            LOGIN,
            Some(ISSUER),
            Some(&anonymous),
            &[
                ("continue", &input(&page.text, "continue")),
                ("csrf_token", &token),
                ("passphrase", PASSWORD),
                ("totp", "not-a-code"),
            ],
        )
        .await;
        assert_eq!(reply.status, status);
        assert!(reply.text.contains(message));
        assert_eq!(sign_in_retry(&reply), target);
        let inner = auth.inner.lock().unwrap();
        assert!(!inner.anonymous_csrf.contains_key(&hash(&token)));
        assert!(inner.stored.grants.is_empty());
        assert!(inner.sessions.is_empty());
    }
}

#[tokio::test]
async fn failed_sign_in_cannot_import_forged_or_cross_session_continuations() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let (uri, target, initial) = pending_sign_in(auth).await;
    let anonymous = cookie(&initial);
    let continuation = authorize_url(APP, &uri);
    for hostile in [
        "https://evil.example/steal".to_string(),
        "//evil.example/steal".into(),
        format!("{AUTHORIZE}/extra?client_id={APP}&request_uri={uri}"),
        format!("{continuation}&request_uri=forged"),
        format!("{continuation}&client_id={APP}"),
        format!("{continuation}&next=https://evil.example"),
        format!("{AUTHORIZE}?"),
        authorize_url("https://other.example", &uri),
        authorize_url(APP, "unknown"),
    ] {
        let page = request(auth, Method::GET, &target, None, Some(&anonymous), &[]).await;
        // Bind a challenge to the hostile continuation deliberately, isolating
        // the defensive route/pending validation after otherwise valid CSRF.
        let token = input(&page.text, "csrf_token");
        auth.inner
            .lock()
            .unwrap()
            .anonymous_csrf
            .get_mut(&hash(&token))
            .unwrap()
            .action = format!("login:{hostile}");
        let reply = request(
            auth,
            Method::POST,
            LOGIN,
            Some(ISSUER),
            Some(&anonymous),
            &[
                ("continue", &hostile),
                ("csrf_token", &token),
                ("passphrase", "wrong passphrase"),
            ],
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{hostile}");
        assert_eq!(sign_in_retry(&reply), LOGIN);
        assert!(!reply.text.contains("evil.example"));
        assert!(
            !auth
                .inner
                .lock()
                .unwrap()
                .anonymous_csrf
                .contains_key(&hash(&token))
        );
    }
    for (foreign_session, wrong_origin, tamper_continuation) in [
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let page = request(auth, Method::GET, &target, None, Some(&anonymous), &[]).await;
        let other = request(auth, Method::GET, LOGIN, None, None, &[]).await;
        let selected_cookie = if foreign_session {
            cookie(&other)
        } else {
            anonymous.clone()
        };
        let posted = if tamper_continuation {
            "https://evil.example"
        } else {
            &continuation
        };
        let reply = request(
            auth,
            Method::POST,
            LOGIN,
            Some(if wrong_origin { APP } else { ISSUER }),
            Some(&selected_cookie),
            &[
                ("continue", posted),
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("passphrase", PASSWORD),
            ],
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(sign_in_retry(&reply), LOGIN);
        assert!(!reply.text.contains("evil.example"));
    }
    let inner = auth.inner.lock().unwrap();
    assert!(inner.sessions.is_empty());
    assert!(inner.stored.grants.is_empty());
}

#[tokio::test]
async fn failed_sign_in_retry_revalidates_pending_expiry_and_entry_point() {
    const SECOND: &str = "https://second.example";
    let dir = std::env::temp_dir().join(random("agent-connect-retry-test-"));
    let mut configuration = config(dir.clone(), Some(PASSWORD));
    configuration.entry_points.push(SECOND.into());
    let fixture = Fixture {
        dir,
        auth: AuthService::open(configuration).unwrap(),
    };
    let auth = &fixture.auth;
    let (uri, target, page) = pending_sign_in(auth).await;
    let anonymous = cookie(&page);
    let cross = request_at(
        auth,
        Method::GET,
        &target,
        None,
        None,
        Some("second.example"),
        &[],
    )
    .await;
    assert_eq!(cross.status, StatusCode::BAD_REQUEST);
    assert_eq!(sign_in_retry(&cross), LOGIN);
    assert!(!cross.headers.contains_key(header::SET_COOKIE));
    let cross_post = request_at(
        auth,
        Method::POST,
        LOGIN,
        Some(SECOND),
        Some(&anonymous),
        Some("second.example"),
        &[
            ("continue", &input(&page.text, "continue")),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("passphrase", PASSWORD),
        ],
    )
    .await;
    assert_eq!(cross_post.status, StatusCode::FORBIDDEN);
    assert_eq!(sign_in_retry(&cross_post), LOGIN);
    // Even an otherwise authenticated form cannot recover a request whose
    // issuer no longer matches. This isolates the pending-record check.
    auth.inner
        .lock()
        .unwrap()
        .pending
        .get_mut(&uri)
        .unwrap()
        .issuer = SECOND.into();
    let altered = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&anonymous),
        &[
            ("continue", &input(&page.text, "continue")),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("passphrase", PASSWORD),
        ],
    )
    .await;
    assert_eq!(altered.status, StatusCode::BAD_REQUEST);
    assert_eq!(sign_in_retry(&altered), LOGIN);
    auth.inner
        .lock()
        .unwrap()
        .pending
        .get_mut(&uri)
        .unwrap()
        .issuer = ISSUER.into();
    let page = request(auth, Method::GET, &target, None, Some(&anonymous), &[]).await;
    let failed = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&anonymous),
        &[
            ("continue", &input(&page.text, "continue")),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("passphrase", "wrong passphrase"),
        ],
    )
    .await;
    assert_eq!(sign_in_retry(&failed), target);
    // A later sign-in page outlives the pending app request. Expiry must be
    // rechecked even with a still-live session and unused matching CSRF.
    advance(auth, 100);
    let later = request(auth, Method::GET, &target, None, None, &[]).await;
    advance(auth, REQUEST_TTL - 99);
    let expired_post = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&cookie(&later)),
        &[
            ("continue", &input(&later.text, "continue")),
            ("csrf_token", &input(&later.text, "csrf_token")),
            ("passphrase", PASSWORD),
        ],
    )
    .await;
    assert_eq!(expired_post.status, StatusCode::BAD_REQUEST);
    assert_eq!(sign_in_retry(&expired_post), LOGIN);
    let expired = request(
        auth,
        Method::GET,
        &sign_in_retry(&failed),
        None,
        Some(&anonymous),
        &[],
    )
    .await;
    assert_eq!(expired.status, StatusCode::BAD_REQUEST);
    assert_eq!(sign_in_retry(&expired), LOGIN);
    assert!(!expired.headers.contains_key(header::SET_COOKIE));
    let inner = auth.inner.lock().unwrap();
    assert!(inner.sessions.is_empty());
    assert!(inner.stored.grants.is_empty());
}

#[tokio::test]
async fn sign_in_cookie_errors_distinguish_missing_duplicates_and_invalid_values() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let (_, _, page) = pending_sign_in(auth).await;
    let anonymous = cookie(&page);
    let fields = [
        ("continue", input(&page.text, "continue")),
        ("csrf_token", input(&page.text, "csrf_token")),
        ("passphrase", "must-not-be-reflected".into()),
    ];
    let fields: Vec<_> = fields
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    for (cookies, diagnostic) in [
        (None, "The sign-in session cookie was not sent"),
        (
            Some("unrelated=must-not-be-reflected".into()),
            "The sign-in session cookie was not sent",
        ),
        (
            Some(format!("{anonymous}; {anonymous}")),
            "More than one sign-in session cookie was sent",
        ),
        (
            Some(format!("__Host-agent_connect_owner; {anonymous}")),
            "More than one sign-in session cookie was sent",
        ),
        (
            Some("__Host-agent_connect_owner=".into()),
            "Your owner session is missing or has expired",
        ),
        (
            Some("__Host-agent_connect_owner=must-not-be-reflected".into()),
            "Your owner session is missing or has expired",
        ),
    ] {
        let reply = request(
            auth,
            Method::POST,
            LOGIN,
            Some(ISSUER),
            cookies.as_deref(),
            &fields,
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert!(reply.text.contains(diagnostic));
        assert_eq!(sign_in_retry(&reply), LOGIN);
        assert!(!reply.text.contains("must-not-be-reflected"));
        assert!(!reply.text.contains(anonymous.split_once('=').unwrap().1));
    }
    let response = auth
        .clone()
        .router()
        .oneshot(
            axum::http::Request::builder()
                .method(Method::POST)
                .uri(LOGIN)
                .header(header::ORIGIN, ISSUER)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header(header::COOKIE, &anonymous)
                .header(header::COOKIE, &anonymous)
                .body(Body::from(serde_urlencoded::to_string(&fields).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let text = String::from_utf8(
        to_bytes(response.into_body(), MAX_BODY)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains("More than one sign-in session cookie was sent"));
    advance(auth, REQUEST_TTL + 1);
    let expired = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&anonymous),
        &fields,
    )
    .await;
    assert_eq!(expired.status, StatusCode::FORBIDDEN);
    assert!(
        expired
            .text
            .contains("Your owner session is missing or has expired")
    );
    assert_eq!(sign_in_retry(&expired), LOGIN);
}

#[test]
fn error_page_escapes_dynamic_retry_link_and_label() {
    let page = pages::error(
        "Error",
        "Message",
        "/login?a='&b=<tag>",
        "Again <script>'\"",
    );
    let document = pages::document(&page);
    assert!(document.contains("href='/login?a=&#39;&amp;b=&lt;tag&gt;'"));
    assert!(document.contains("Again &lt;script&gt;&#39;&quot;"));
    assert!(!document.contains("<script>"));
}

#[tokio::test]
async fn owner_error_never_reflects_raw_errors_or_untrusted_return_paths() {
    let response = owner_error(
        StatusCode::BAD_REQUEST,
        "<script>secret/path/token</script>",
        "https://evil.example/<script>",
        None,
    );
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let text = String::from_utf8(
        to_bytes(response.into_body(), MAX_BODY)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!text.contains("secret/path/token"));
    assert!(!text.contains("evil.example"));
    assert!(!text.contains("<script>"));
    assert!(text.contains("href='/agent-connect/owner'"));
    assert!(page_csp(None, "", "").contains("style-src 'sha256-"));
}

#[tokio::test]
async fn overloaded_owner_forms_keep_html_and_security_headers() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let _permit = auth.requests.acquire_many(32).await.unwrap();
    let response = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        None,
        &[("passphrase", "unshown-private-value")],
    )
    .await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response.headers[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers["x-frame-options"], "DENY");
    assert!(response.text.contains("Gateway is busy"));
    assert!(!response.text.contains("unshown-private-value"));
    let response = request(auth, Method::POST, TOKEN, Some(APP), None, &[]).await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.json()["error"], "slow_down");
}

fn form_token(page: &str, action: &str) -> String {
    let marker = format!("action='{action}'>");
    input(
        page.split(&marker)
            .nth(1)
            .unwrap()
            .split("</form>")
            .next()
            .unwrap(),
        "csrf_token",
    )
}

struct RuntimeFixture {
    auth: std::sync::Weak<AuthService>,
    view: OwnerRuntimeSnapshot,
    ended: Mutex<Vec<String>>,
}
impl OwnerRuntime for RuntimeFixture {
    fn snapshot(&self) -> OwnerRuntimeSnapshot {
        assert!(self.auth.upgrade().unwrap().inner.try_lock().is_ok());
        self.view.clone()
    }
    fn end_session(&self, id: &str) -> Result<()> {
        assert!(self.auth.upgrade().unwrap().inner.try_lock().is_ok());
        ensure!(
            self.view.sessions.iter().any(|session| session.id == id),
            "invalid_session"
        );
        self.ended.lock().unwrap().push(id.to_string());
        Ok(())
    }
}

#[tokio::test]
async fn owner_runtime_controls_are_csrf_bound_and_keep_grants() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    let tokens = exchange(
        auth,
        &code(&consent(auth, &owner, &uri, "approve", "", "3600").await),
        VERIFIER,
        APP,
    )
    .await
    .json();
    let bearer = tokens["access_token"].as_str().unwrap();
    let grant_id = tokens["grant_id"].as_str().unwrap();
    let runtime = Arc::new(RuntimeFixture {
        auth: Arc::downgrade(auth),
        view: OwnerRuntimeSnapshot {
            problems: vec![OwnerProblem {
                message: "Repair <runtime>".into(),
                repair: "Run doctor & review configuration".into(),
            }],
            sessions: vec![OwnerSession {
                id: "live-one".into(),
                grant_id: grant_id.into(),
                state: "Connected".into(),
                started_at: auth.now(),
            }],
        },
        ended: Mutex::new(Vec::new()),
    });
    auth.set_runtime(runtime.clone()).unwrap();
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    assert!(page.text.contains("runtime-problem' role='status"));
    assert!(page.text.contains("Repair &lt;runtime&gt;"));
    assert!(page.text.contains("doctor &amp; review"));
    assert!(page.text.contains("is connected"));
    assert!(
        !page
            .text
            .contains(&format!("<h3 class='origin'>{grant_id}</h3>"))
    );
    let token = form_token(&page.text, "/agent-connect/owner/sessions/end");
    let tampered = request(
        auth,
        Method::POST,
        "/agent-connect/owner/sessions/end",
        Some(ISSUER),
        Some(&owner),
        &[("csrf_token", &token), ("session_id", "another-session")],
    )
    .await;
    assert_eq!(tampered.status, StatusCode::FORBIDDEN);
    assert!(runtime.ended.lock().unwrap().is_empty());
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    let token = form_token(&page.text, "/agent-connect/owner/sessions/end");
    let ended = request(
        auth,
        Method::POST,
        "/agent-connect/owner/sessions/end",
        Some(ISSUER),
        Some(&owner),
        &[("csrf_token", &token), ("session_id", "live-one")],
    )
    .await;
    assert_eq!(ended.status, StatusCode::FOUND, "{}", ended.text);
    assert_eq!(*runtime.ended.lock().unwrap(), vec!["live-one"]);
    assert!(auth.authenticate(bearer, APP).is_ok());
    let replay = request(
        auth,
        Method::POST,
        "/agent-connect/owner/sessions/end",
        Some(ISSUER),
        Some(&owner),
        &[("csrf_token", &token), ("session_id", "live-one")],
    )
    .await;
    assert_eq!(replay.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn revoke_all_invalidates_grants_and_codes_but_keeps_owner() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    let tokens = exchange(
        auth,
        &code(&consent(auth, &owner, &uri, "approve", "", "3600").await),
        VERIFIER,
        APP,
    )
    .await
    .json();
    let bearer = tokens["access_token"].as_str().unwrap();
    let refresh_token = tokens["refresh_token"].as_str().unwrap();
    let uri = pushed(auth).await;
    let outstanding_code = code(&consent(auth, &owner, &uri, "approve", "", "3600").await);
    let page = request(auth, Method::GET, pages::SECURITY, None, Some(&owner), &[]).await;
    let token = form_token(&page.text, "/agent-connect/owner/grants/revoke-all");
    let bad_origin = request(
        auth,
        Method::POST,
        "/agent-connect/owner/grants/revoke-all",
        Some(APP),
        Some(&owner),
        &[("csrf_token", &token)],
    )
    .await;
    assert_eq!(bad_origin.status, StatusCode::FORBIDDEN);
    assert!(auth.authenticate(bearer, APP).is_ok());
    let reply = request(
        auth,
        Method::POST,
        "/agent-connect/owner/grants/revoke-all",
        Some(ISSUER),
        Some(&owner),
        &[("csrf_token", &token)],
    )
    .await;
    assert_eq!(reply.status, StatusCode::FOUND);
    assert!(auth.authenticate(bearer, APP).is_err());
    assert_eq!(
        refresh(auth, refresh_token).await.json()["error"],
        "invalid_grant"
    );
    assert_eq!(
        exchange(auth, &outstanding_code, VERIFIER, APP)
            .await
            .json()["error"],
        "invalid_grant"
    );
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn logout_expires_owner_cookie_without_revoking_application() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    let tokens = exchange(
        auth,
        &code(&consent(auth, &owner, &uri, "approve", "", "3600").await),
        VERIFIER,
        APP,
    )
    .await
    .json();
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    let token = form_token(&page.text, "/agent-connect/owner/logout");
    let reply = request(
        auth,
        Method::POST,
        "/agent-connect/owner/logout",
        Some(ISSUER),
        Some(&owner),
        &[("csrf_token", &token)],
    )
    .await;
    assert_eq!(reply.status, StatusCode::FOUND);
    assert_eq!(
        reply.headers[header::SET_COOKIE],
        "__Host-agent_connect_owner=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"
    );
    assert!(
        auth.authenticate(tokens["access_token"].as_str().unwrap(), APP)
            .is_ok()
    );
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::FOUND
    );
}

#[tokio::test]
async fn owner_cookie_policy_follows_each_entry_point_through_login_and_logout() {
    let dir = std::env::temp_dir().join(random("agent-connect-cookie-test-"));
    let mut configuration = config(dir.clone(), Some(PASSWORD));
    configuration.entry_points = vec![
        "http://localhost:19840".into(),
        "https://second.example".into(),
        "https://gateway.example:9443".into(),
    ];
    let fixture = Fixture {
        dir,
        auth: AuthService::open(configuration).unwrap(),
    };
    let auth = &fixture.auth;
    let endpoints = [
        (
            ISSUER,
            "gateway.example",
            "__Host-agent_connect_owner",
            "/",
            "; Secure",
        ),
        (
            "http://localhost:19840",
            "localhost:19840",
            "agent_connect_owner",
            "/agent-connect",
            "",
        ),
        (
            "https://second.example",
            "second.example",
            "__Host-agent_connect_owner",
            "/",
            "; Secure",
        ),
        (
            "https://gateway.example:9443",
            "gateway.example:9443",
            "__Host-agent_connect_owner",
            "/",
            "; Secure",
        ),
    ];
    let mut owners = Vec::new();
    for (origin, host, name, path, secure) in endpoints {
        let page = request_at(auth, Method::GET, LOGIN, None, None, Some(host), &[]).await;
        let anonymous = cookie(&page);
        assert!(anonymous.starts_with(&format!("{name}=anonymous_")));
        assert_eq!(
            page.headers[header::SET_COOKIE],
            format!("{anonymous}; Path={path}; HttpOnly; SameSite=Lax; Max-Age=43200{secure}")
        );
        let reply = request_at(
            auth,
            Method::POST,
            LOGIN,
            Some(origin),
            Some(&anonymous),
            Some(host),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("passphrase", PASSWORD),
            ],
        )
        .await;
        assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
        let owner = cookie(&reply);
        assert!(owner.starts_with(&format!("{name}=owner_")));
        assert_eq!(
            reply.headers[header::SET_COOKIE],
            format!("{owner}; Path={path}; HttpOnly; SameSite=Lax; Max-Age=43200{secure}")
        );
        assert_ne!(anonymous, owner);
        // The anonymous credential is retired, not promoted in place.
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        headers.insert(header::COOKIE, HeaderValue::from_str(&anonymous).unwrap());
        assert!(
            auth.session_id(&auth.inner.lock().unwrap(), &headers, false)
                .is_err()
        );
        owners.push(owner);
    }
    for (index, (origin, host, name, path, secure)) in endpoints.into_iter().enumerate() {
        for (other, owner) in owners.iter().enumerate() {
            // Rename copied credentials to the destination policy so origin binding
            // is tested independently of the HTTPS/HTTP cookie-name distinction.
            let copied = format!("{name}={}", owner.split_once('=').unwrap().1);
            let page = request_at(
                auth,
                Method::GET,
                OWNER,
                None,
                Some(&copied),
                Some(host),
                &[],
            )
            .await;
            assert_eq!(
                page.status,
                if index == other {
                    StatusCode::OK
                } else {
                    StatusCode::FOUND
                }
            );
        }
        let owner = &owners[index];
        let page = request_at(auth, Method::GET, OWNER, None, Some(owner), Some(host), &[]).await;
        let reply = request_at(
            auth,
            Method::POST,
            "/agent-connect/owner/logout",
            Some(origin),
            Some(owner),
            Some(host),
            &[(
                "csrf_token",
                &form_token(&page.text, "/agent-connect/owner/logout"),
            )],
        )
        .await;
        assert_eq!(reply.status, StatusCode::FOUND);
        assert_eq!(
            reply.headers[header::SET_COOKIE],
            format!("{name}=; Path={path}; HttpOnly; SameSite=Lax; Max-Age=0{secure}")
        );
        assert_eq!(
            request_at(auth, Method::GET, OWNER, None, Some(owner), Some(host), &[])
                .await
                .status,
            StatusCode::FOUND
        );
    }
}

#[tokio::test]
async fn https_owner_cookie_ignores_legacy_credentials_during_login() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
    let anonymous = cookie(&page);
    let fields = [
        ("csrf_token", input(&page.text, "csrf_token")),
        ("passphrase", PASSWORD.into()),
    ];
    let fields: Vec<_> = fields
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let legacy = anonymous.strip_prefix("__Host-").unwrap();
    for invalid in [legacy.to_string(), format!("{anonymous}; {anonymous}")] {
        let reply = request(
            auth,
            Method::POST,
            LOGIN,
            Some(ISSUER),
            Some(&invalid),
            &fields,
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
    }
    // Even oversized and duplicate legacy values must not poison the selected cookie.
    let polluted = format!(
        "agent_connect_owner={}; {anonymous}; {legacy}",
        "x".repeat(257)
    );
    let reply = request(
        auth,
        Method::POST,
        LOGIN,
        Some(ISSUER),
        Some(&polluted),
        &fields,
    )
    .await;
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let owner = cookie(&reply);
    assert!(owner.starts_with("__Host-agent_connect_owner=owner_"));
    let polluted = format!("{legacy}; {owner}; agent_connect_owner=other");
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(&polluted), &[])
            .await
            .status,
        StatusCode::OK
    );
    let legacy_owner = owner.strip_prefix("__Host-").unwrap();
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(legacy_owner), &[])
            .await
            .status,
        StatusCode::FOUND
    );
}

#[tokio::test]
async fn owner_cookie_rejects_invalid_or_duplicate_selected_credentials() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let invalid = [
        owner.clone(),
        "__Host-agent_connect_owner=".into(),
        "__Host-agent_connect_owner".into(),
        "__Host-agent_connect_owner=unknown".into(),
        format!("__Host-agent_connect_owner={}", "x".repeat(257)),
    ];
    for extra in &invalid {
        for separate_headers in [false, true] {
            for reverse in [false, true] {
                let (first, second) = if reverse {
                    (extra, &owner)
                } else {
                    (&owner, extra)
                };
                let mut builder = axum::http::Request::builder().uri(OWNER);
                builder = if separate_headers {
                    builder
                        .header(header::COOKIE, first)
                        .header(header::COOKIE, second)
                } else {
                    builder.header(header::COOKIE, format!("{first}; {second}"))
                };
                let response = auth
                    .clone()
                    .router()
                    .oneshot(builder.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::FOUND,
                    "{extra}, separate={separate_headers}, reverse={reverse}"
                );
                assert_eq!(response.headers()[header::LOCATION], LOGIN);
            }
        }
    }
    let response = auth
        .clone()
        .router()
        .oneshot(
            axum::http::Request::builder()
                .uri(OWNER)
                .header(header::COOKIE, "agent_connect_owner=stale")
                .header(header::COOKIE, &owner)
                .header(header::COOKIE, "agent_connect_owner=duplicate")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn owner_cookie_ignores_non_ascii_values_in_unrelated_cookie_names() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    for name in ["agent_connect_owner", "unrelated"] {
        let mut unrelated = format!("{name}=legacy-").into_bytes();
        unrelated.push(0xff);
        for separate_headers in [false, true] {
            for reverse in [false, true] {
                let (first, second) = if reverse {
                    (unrelated.as_slice(), owner.as_bytes())
                } else {
                    (owner.as_bytes(), unrelated.as_slice())
                };
                let mut builder = axum::http::Request::builder()
                    .uri(OWNER)
                    .header(header::HOST, "gateway.example");
                builder = if separate_headers {
                    builder
                        .header(header::COOKIE, HeaderValue::from_bytes(first).unwrap())
                        .header(header::COOKIE, HeaderValue::from_bytes(second).unwrap())
                } else {
                    let mut combined = first.to_vec();
                    combined.extend_from_slice(b"; ");
                    combined.extend_from_slice(second);
                    builder.header(header::COOKIE, HeaderValue::from_bytes(&combined).unwrap())
                };
                let response = auth
                    .clone()
                    .router()
                    .oneshot(builder.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::OK,
                    "{name}, separate={separate_headers}, reverse={reverse}"
                );
            }
        }
    }
}

#[tokio::test]
async fn owner_cookie_rejects_non_ascii_selected_values() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    for bytes in [&[0xff][..], "\u{00ff}".as_bytes()] {
        let mut invalid = b"__Host-agent_connect_owner=owner-".to_vec();
        invalid.extend_from_slice(bytes);
        for with_valid in [false, true] {
            let mut builder = axum::http::Request::builder()
                .uri(OWNER)
                .header(header::HOST, "gateway.example")
                .header(header::COOKIE, HeaderValue::from_bytes(&invalid).unwrap());
            if with_valid {
                builder = builder.header(header::COOKIE, &owner);
            }
            let response = auth
                .clone()
                .router()
                .oneshot(builder.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FOUND);
            assert_eq!(response.headers()[header::LOCATION], LOGIN);
        }
    }
    assert_eq!(
        request(auth, Method::GET, OWNER, None, Some(&owner), &[])
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn profile_choice_is_fixed_in_grant_and_unoffered_profiles_are_rejected() {
    let dir = std::env::temp_dir().join(random("agent-connect-profile-test-"));
    let mut configuration = config(dir.clone(), Some(PASSWORD));
    configuration.profiles.push(PermissionProfile::ReadOnly);
    let auth = AuthService::open(configuration).unwrap();
    let owner = login(&auth, "").await;
    let uri = pushed(&auth).await;
    let page = request(
        &auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        Some(&owner),
        &[],
    )
    .await;
    assert!(page.text.contains("name=profile"));
    assert!(
        page.text
            .contains("Approved app tools still work and other permission requests are denied")
    );
    assert!(
        page.text
            .contains("sessions refuse to run instead of running unrestricted")
    );
    let invalid = request(
        &auth,
        Method::POST,
        AUTHORIZE,
        Some(ISSUER),
        Some(&owner),
        &[
            ("request_uri", &uri),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("decision", "approve"),
            ("duration", "3600"),
            ("profile", "app-tools-only"),
        ],
    )
    .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
    assert!(auth.inner.lock().unwrap().stored.grants.is_empty());
    let page = request(
        &auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        Some(&owner),
        &[],
    )
    .await;
    let approved = request(
        &auth,
        Method::POST,
        AUTHORIZE,
        Some(ISSUER),
        Some(&owner),
        &[
            ("request_uri", &uri),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("decision", "approve"),
            ("duration", "3600"),
            ("profile", "read-only"),
        ],
    )
    .await;
    let tokens = exchange(&auth, &code(&approved), VERIFIER, APP)
        .await
        .json();
    let bearer = tokens["access_token"].as_str().unwrap();
    let principal = auth.authenticate(bearer, APP).unwrap();
    assert_eq!(principal.permissions, PermissionProfile::ReadOnly);
    let mut expanded = principal.clone();
    expanded.permissions = PermissionProfile::Sandboxed;
    assert!(!auth.recheck(&expanded));
    drop(auth);
    let auth = AuthService::open(config(dir.clone(), None)).unwrap();
    // Retiring an offered choice does not rewrite the authority already approved.
    assert_eq!(
        auth.authenticate(bearer, APP).unwrap().permissions,
        PermissionProfile::ReadOnly
    );
    drop(auth);
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn legacy_default_grant_survives_upgrade_and_entry_point_addition() {
    let dir = std::env::temp_dir().join(random("agent-connect-upgrade-test-"));
    let auth = AuthService::open(config(dir.clone(), Some(PASSWORD))).unwrap();
    let owner = login(&auth, "").await;
    let uri = pushed(&auth).await;
    let tokens = exchange(
        &auth,
        &code(&consent(&auth, &owner, &uri, "approve", "", "3600").await),
        VERIFIER,
        APP,
    )
    .await
    .json();
    let bearer = tokens["access_token"].as_str().unwrap();
    drop(auth);
    let path = dir.join("authorization.json");
    let mut stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for grant in stored["grants"].as_array_mut().unwrap() {
        grant.as_object_mut().unwrap().remove("profile");
        grant.as_object_mut().unwrap().remove("issuer");
        grant.as_object_mut().unwrap().remove("approved_at");
        grant.as_object_mut().unwrap().remove("revoked_at");
    }
    stored.as_object_mut().unwrap().remove("totp_reset_count");
    stored.as_object_mut().unwrap().remove("last_totp_reset_at");
    fs::write(path, serde_json::to_vec(&stored).unwrap()).unwrap();
    let mut configuration = config(dir.clone(), None);
    configuration.profiles.push(PermissionProfile::ReadOnly);
    configuration
        .entry_points
        .push("https://second.example".into());
    let auth = AuthService::open(configuration).unwrap();
    {
        let inner = auth.inner.lock().unwrap();
        assert_eq!(inner.stored.grants[0].approved_at, None);
        assert_eq!(inner.stored.grants[0].revoked_at, None);
    }

    assert_eq!(
        auth.authenticate(bearer, APP).unwrap().permissions,
        PermissionProfile::Sandboxed
    );
    drop(auth);
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn reset_totp_requires_stopped_gateway_preserves_grants_and_passphrase() {
    let dir = std::env::temp_dir().join(random("agent-connect-reset-test-"));
    let auth = AuthService::open(config(dir.clone(), Some(PASSWORD))).unwrap();
    let owner = login(&auth, "").await;
    let uri = pushed(&auth).await;
    let tokens = exchange(
        &auth,
        &code(&consent(&auth, &owner, &uri, "approve", "", "3600").await),
        VERIFIER,
        APP,
    )
    .await
    .json();
    let before = {
        let mut inner = auth.inner.lock().unwrap();
        let mut next = inner.stored.clone();
        next.totp_secret = Some(base32(&[9; 20]));
        next.last_totp_step = Some(auth.now() / 30);
        auth.commit(&mut inner, next.clone()).unwrap();
        next
    };
    assert!(
        AuthService::reset_totp(&dir)
            .unwrap_err()
            .to_string()
            .contains("stop the gateway")
    );
    drop(auth);
    assert!(AuthService::reset_totp(&dir).unwrap());
    assert!(!AuthService::reset_totp(&dir).unwrap());
    let auth = AuthService::open(config(dir.clone(), None)).unwrap();
    {
        let inner = auth.inner.lock().unwrap();
        assert!(inner.stored.totp_secret.is_none());
        assert!(inner.stored.last_totp_step.is_none());
        assert_eq!(inner.stored.password_hash, before.password_hash);
        assert_eq!(
            serde_json::to_value(&inner.stored.grants).unwrap(),
            serde_json::to_value(&before.grants).unwrap()
        );
        assert_eq!(inner.stored.totp_reset_count, 1);
        assert!(inner.stored.last_totp_reset_at.is_some());
    }
    assert!(
        auth.authenticate(tokens["access_token"].as_str().unwrap(), APP)
            .is_ok()
    );
    login(&auth, "").await;
    drop(auth);
    fs::remove_dir_all(&dir).unwrap();
    assert!(AuthService::reset_totp(&dir).is_err());
    assert!(!dir.exists());
}

#[tokio::test]
async fn reset_passphrase_requires_stopped_gateway_and_preserves_grants() {
    const REPLACEMENT: &str = "replacement owner passphrase";
    let dir = std::env::temp_dir().join(random("agent-connect-reset-passphrase-"));
    let auth = AuthService::open(config(dir.clone(), Some(PASSWORD))).unwrap();
    let owner = login(&auth, "").await;
    let uri = pushed(&auth).await;
    let tokens = exchange(
        &auth,
        &code(&consent(&auth, &owner, &uri, "approve", "", "3600").await),
        VERIFIER,
        APP,
    )
    .await
    .json();
    let before = auth.inner.lock().unwrap().stored.clone();
    assert!(
        AuthService::reset_passphrase(&dir, REPLACEMENT)
            .unwrap_err()
            .to_string()
            .contains("stop the gateway")
    );
    drop(auth);
    assert!(AuthService::reset_passphrase(&dir, "too short").is_err());
    AuthService::reset_passphrase(&dir, REPLACEMENT).unwrap();
    let auth = AuthService::open(config(dir.clone(), None)).unwrap();
    {
        let inner = auth.inner.lock().unwrap();
        let hash = PasswordHash::new(&inner.stored.password_hash).unwrap();
        assert!(
            Argon2::default()
                .verify_password(REPLACEMENT.as_bytes(), &hash)
                .is_ok()
        );
        assert!(
            Argon2::default()
                .verify_password(PASSWORD.as_bytes(), &hash)
                .is_err()
        );
        assert_eq!(
            serde_json::to_value(&inner.stored.grants).unwrap(),
            serde_json::to_value(&before.grants).unwrap()
        );
    }
    assert!(
        auth.authenticate(tokens["access_token"].as_str().unwrap(), APP)
            .is_ok()
    );
    drop(auth);
    fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn entry_points_pair_with_exact_issuer_and_bind_owner_sessions_to_origin() {
    const SECOND: &str = "http://localhost:19840";
    const SECOND_HOST: &str = "localhost:19840";
    let dir = std::env::temp_dir().join(random("agent-connect-entry-test-"));
    let mut configuration = config(dir.clone(), Some(PASSWORD));
    configuration.entry_points.push(SECOND.into());
    let auth = AuthService::open(configuration).unwrap();
    let mut host_headers = HeaderMap::new();
    assert!(auth.entry_point(&host_headers).is_err());
    host_headers.insert(header::HOST, HeaderValue::from_static(SECOND_HOST));
    assert_eq!(auth.entry_point(&host_headers).unwrap(), SECOND);
    host_headers.append(header::HOST, HeaderValue::from_static("gateway.example"));
    assert!(auth.entry_point(&host_headers).is_err());
    host_headers.insert(
        header::HOST,
        HeaderValue::from_static("unconfigured.example"),
    );
    host_headers.insert("x-forwarded-host", HeaderValue::from_static(SECOND_HOST));
    assert!(auth.entry_point(&host_headers).is_err());
    let primary_owner = login(&auth, "").await;
    let canonical_tokens = pair(&auth, &primary_owner, "3600").await;
    let canonical_bearer = canonical_tokens["access_token"].as_str().unwrap();
    assert!(auth.authenticate_at(canonical_bearer, APP, ISSUER).is_ok());
    assert!(auth.authenticate_at(canonical_bearer, APP, SECOND).is_err());
    let cross = request_at(
        &auth,
        Method::GET,
        OWNER,
        None,
        Some(&primary_owner),
        Some(SECOND_HOST),
        &[],
    )
    .await;
    assert_eq!(cross.status, StatusCode::FOUND);
    let page = request_at(
        &auth,
        Method::GET,
        LOGIN,
        None,
        None,
        Some(SECOND_HOST),
        &[],
    )
    .await;
    assert!(
        !page.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Secure")
    );
    let reply = request_at(
        &auth,
        Method::POST,
        LOGIN,
        Some(SECOND),
        Some(&cookie(&page)),
        Some(SECOND_HOST),
        &[
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("continue", ""),
            ("passphrase", PASSWORD),
        ],
    )
    .await;
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let owner = cookie(&reply);
    let metadata = request_at(
        &auth,
        Method::GET,
        "/.well-known/oauth-authorization-server/agent-connect",
        None,
        None,
        Some(SECOND_HOST),
        &[],
    )
    .await;
    assert_eq!(metadata.json()["issuer"], SECOND);
    let details = json!([{"type":"agent_connect","tools":[{"name":"read","description":"Read an application item","inputSchema":{"type":"object"}}]}]).to_string();
    let challenge = hash(VERIFIER);
    let resource = format!("{SECOND}/acp");
    let par = request_at(
        &auth,
        Method::POST,
        PAR,
        Some(APP),
        None,
        Some(SECOND_HOST),
        &[
            ("client_id", APP),
            ("redirect_uri", "https://app.example/callback"),
            ("resource", &resource),
            ("response_type", "code"),
            ("scope", "acp"),
            ("state", "second-state"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("authorization_details", &details),
        ],
    )
    .await;
    assert_eq!(par.status, StatusCode::CREATED, "{}", par.text);
    let uri = par.json()["request_uri"].as_str().unwrap().to_string();
    let page = request_at(
        &auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        Some(&owner),
        Some(SECOND_HOST),
        &[],
    )
    .await;
    assert_eq!(page.status, StatusCode::OK);
    let cross_origin = request_at(
        &auth,
        Method::POST,
        AUTHORIZE,
        Some(ISSUER),
        Some(&owner),
        Some(SECOND_HOST),
        &[
            ("request_uri", &uri),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("decision", "approve"),
            ("duration", "3600"),
            ("profile", "sandboxed"),
        ],
    )
    .await;
    assert_eq!(cross_origin.status, StatusCode::FORBIDDEN);
    let approved = request_at(
        &auth,
        Method::POST,
        AUTHORIZE,
        Some(SECOND),
        Some(&owner),
        Some(SECOND_HOST),
        &[
            ("request_uri", &uri),
            ("csrf_token", &input(&page.text, "csrf_token")),
            ("decision", "approve"),
            ("duration", "3600"),
            ("profile", "sandboxed"),
        ],
    )
    .await;
    assert_eq!(approved.status, StatusCode::FOUND, "{}", approved.text);
    let callback = Url::parse(approved.headers[header::LOCATION].to_str().unwrap()).unwrap();
    assert_eq!(
        callback
            .query_pairs()
            .find(|(key, _)| key == "iss")
            .unwrap()
            .1,
        SECOND
    );
    let code = callback
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1
        .into_owned();
    let token_fields = [
        ("client_id", APP),
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("code_verifier", VERIFIER),
        ("redirect_uri", "https://app.example/callback"),
        ("resource", resource.as_str()),
    ];
    let primary = request_at(
        &auth,
        Method::POST,
        TOKEN,
        Some(APP),
        None,
        Some("gateway.example"),
        &token_fields,
    )
    .await;
    assert_eq!(primary.json()["error"], "invalid_target");
    let issued = request_at(
        &auth,
        Method::POST,
        TOKEN,
        Some(APP),
        None,
        Some(SECOND_HOST),
        &token_fields,
    )
    .await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    assert_eq!(issued.json()["gateway_url"], "ws://localhost:19840/acp");
    let alias_tokens = issued.json();
    let alias_bearer = alias_tokens["access_token"].as_str().unwrap();
    let principal = auth.authenticate_at(alias_bearer, APP, SECOND).unwrap();
    assert_eq!(principal.issuer, SECOND);
    assert!(auth.recheck(&principal));
    assert!(auth.authenticate_at(alias_bearer, APP, ISSUER).is_err());
    assert!(
        auth.authenticate_at(alias_bearer, APP, "https://unconfigured.example")
            .is_err()
    );
    let mut changed_audience = principal.clone();
    changed_audience.issuer = ISSUER.into();
    assert!(!auth.recheck(&changed_audience));
    let refresh_token = issued.json()["refresh_token"].as_str().unwrap().to_string();
    let primary_refresh = request_at(
        &auth,
        Method::POST,
        TOKEN,
        Some(APP),
        None,
        Some("gateway.example"),
        &[
            ("client_id", APP),
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
            ("resource", "https://gateway.example/acp"),
        ],
    )
    .await;
    assert_eq!(primary_refresh.json()["error"], "invalid_grant");
    let refreshed = request_at(
        &auth,
        Method::POST,
        TOKEN,
        Some(APP),
        None,
        Some(SECOND_HOST),
        &[
            ("client_id", APP),
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
            ("resource", &resource),
        ],
    )
    .await;
    assert_eq!(refreshed.status, StatusCode::OK);
    let page = request_at(
        &auth,
        Method::GET,
        OWNER,
        None,
        Some(&owner),
        Some(SECOND_HOST),
        &[],
    )
    .await;
    let page = request_at(
        &auth,
        Method::GET,
        pages::GATEWAY,
        None,
        Some(&owner),
        Some(SECOND_HOST),
        &[],
    )
    .await;
    assert!(page.text.contains(&format!("data-copy='{SECOND}'")));
    drop(auth);
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn entry_point_totp_enrollment_and_verification_cannot_cross_origins() {
    const SECOND: &str = "https://second.example";
    let dir = std::env::temp_dir().join(random("agent-connect-factor-origin-test-"));
    let mut configuration = config(dir.clone(), Some(PASSWORD));
    configuration.entry_points.push(SECOND.into());
    let auth = AuthService::open(configuration).unwrap();
    let primary_owner = login(&auth, "").await;
    let page = request(
        &auth,
        Method::GET,
        pages::TOTP,
        None,
        Some(&primary_owner),
        &[],
    )
    .await;
    let token = form_token(&page.text, "/agent-connect/owner/totp/enroll");
    let cross = request_at(
        &auth,
        Method::POST,
        "/agent-connect/owner/totp/enroll",
        Some(SECOND),
        Some(&primary_owner),
        Some("second.example"),
        &[("csrf_token", &token), ("passphrase", PASSWORD)],
    )
    .await;
    assert_ne!(cross.status, StatusCode::OK);
    let enrolled = request(
        &auth,
        Method::POST,
        "/agent-connect/owner/totp/enroll",
        Some(ISSUER),
        Some(&primary_owner),
        &[("csrf_token", &token), ("passphrase", PASSWORD)],
    )
    .await;
    assert_eq!(enrolled.status, StatusCode::OK, "{}", enrolled.text);
    let secret = enrollment_secret(&enrolled.text);
    let factor = totp(&secret, auth.now() / 30).unwrap();
    let token = input(&enrolled.text, "csrf_token");
    let cross = request_at(
        &auth,
        Method::POST,
        "/agent-connect/owner/totp/verify",
        Some(SECOND),
        Some(&primary_owner),
        Some("second.example"),
        &[("csrf_token", &token), ("totp", &factor)],
    )
    .await;
    assert_ne!(cross.status, StatusCode::FOUND);
    assert!(auth.inner.lock().unwrap().stored.totp_secret.is_none());
    let verified = request(
        &auth,
        Method::POST,
        "/agent-connect/owner/totp/verify",
        Some(ISSUER),
        Some(&primary_owner),
        &[("csrf_token", &token), ("totp", &factor)],
    )
    .await;
    assert_eq!(verified.status, StatusCode::FOUND);
    assert!(auth.inner.lock().unwrap().stored.totp_secret.is_some());
    drop(auth);
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn owner_sections_require_session_reject_queries_and_removed_route() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    for (path, heading) in [
        (pages::SECURITY, "Security"),
        (pages::GATEWAY, "Gateway"),
        (pages::TOTP, "Set up an authenticator"),
    ] {
        let anonymous = request(auth, Method::GET, path, None, None, &[]).await;
        assert_eq!(anonymous.status, StatusCode::FOUND);
        assert_eq!(anonymous.headers["location"], LOGIN);
        let page = request(auth, Method::GET, path, None, Some(&owner), &[]).await;
        assert_eq!(page.status, StatusCode::OK);
        assert!(page.text.contains(&format!("<h1>{heading}</h1>")));
        assert_eq!(
            request(
                auth,
                Method::GET,
                &format!("{path}?unexpected=1"),
                None,
                Some(&owner),
                &[]
            )
            .await
            .status,
            StatusCode::BAD_REQUEST
        );
    }
    for method in [Method::GET, Method::POST] {
        assert_eq!(
            request(
                auth,
                method,
                "/agent-connect/owner/forget-browser",
                Some(ISSUER),
                Some(&owner),
                &[]
            )
            .await
            .status,
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn grant_activity_times_are_persisted_on_every_revoke_path() {
    for mode in ["owner", "all", "application", "reuse"] {
        let fixture = Fixture::new();
        let auth = &fixture.auth;
        let owner = login(auth, "").await;
        let approved = auth.now();
        let tokens = pair(auth, &owner, "3600").await;
        {
            let inner = auth.inner.lock().unwrap();
            assert_eq!(inner.stored.grants[0].approved_at, Some(approved));
            assert_eq!(inner.stored.grants[0].revoked_at, None);
        }
        advance(auth, 30);
        match mode {
            "owner" | "all" => {
                let (page_path, action) = if mode == "owner" {
                    (OWNER, "/agent-connect/owner/grants/revoke")
                } else {
                    (pages::SECURITY, "/agent-connect/owner/grants/revoke-all")
                };
                let page = request(auth, Method::GET, page_path, None, Some(&owner), &[]).await;
                let token = form_token(&page.text, action);
                let mut fields = vec![("csrf_token", token.as_str())];
                if mode == "owner" {
                    fields.push(("grant_id", tokens["grant_id"].as_str().unwrap()));
                }
                assert_eq!(
                    request(
                        auth,
                        Method::POST,
                        action,
                        Some(ISSUER),
                        Some(&owner),
                        &fields
                    )
                    .await
                    .status,
                    StatusCode::FOUND
                );
            }
            "application" => {
                assert_eq!(
                    request(
                        auth,
                        Method::POST,
                        REVOKE,
                        Some(APP),
                        None,
                        &[
                            ("client_id", APP),
                            ("token", tokens["access_token"].as_str().unwrap())
                        ]
                    )
                    .await
                    .status,
                    StatusCode::OK
                );
            }
            _ => {
                let token = tokens["refresh_token"].as_str().unwrap();
                assert_eq!(refresh(auth, token).await.status, StatusCode::OK);
                assert_eq!(refresh(auth, token).await.status, StatusCode::BAD_REQUEST);
            }
        }
        let stored: Stored =
            serde_json::from_slice(&fs::read(fixture.dir.join("authorization.json")).unwrap())
                .unwrap();
        assert_eq!(stored.grants[0].approved_at, Some(approved), "{mode}");
        assert_eq!(stored.grants[0].revoked_at, Some(auth.now()), "{mode}");
        assert!(stored.grants[0].revoked, "{mode}");
    }
}

#[tokio::test]
async fn consent_client_form_action_and_activity_track_have_hashed_styles() {
    let fixture = Fixture::new();
    let auth = &fixture.auth;
    let owner = login(auth, "").await;
    let uri = pushed(auth).await;
    let page = request(
        auth,
        Method::GET,
        &authorize_url(APP, &uri),
        None,
        Some(&owner),
        &[],
    )
    .await;
    assert!(
        page.headers["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("form-action 'self' https://app.example")
    );
    assert_style_hashes(&page, 1);
    let _ = consent(auth, &owner, &uri, "approve", "", "3600").await;
    let page = request(auth, Method::GET, OWNER, None, Some(&owner), &[]).await;
    assert!(page.text.contains("class='track'"));
    assert_style_hashes(&page, 2);
}
