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
        client_address_policies: Default::default(),
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
        attempt_budget(
            &mut budgets,
            &ClientSource::legacy(Some(first)),
            1000,
            900,
            10,
            "login_rate_limited",
            false,
        )
        .unwrap();
    }
    assert!(
        attempt_budget(
            &mut budgets,
            &ClientSource::legacy(Some(first)),
            1000,
            900,
            10,
            "login_rate_limited",
            false
        )
        .is_err()
    );
    attempt_budget(
        &mut budgets,
        &ClientSource::legacy(Some(other)),
        1000,
        900,
        10,
        "login_rate_limited",
        false,
    )
    .unwrap();
    attempt_budget(
        &mut budgets,
        &ClientSource::legacy(Some(first)),
        1900,
        900,
        10,
        "login_rate_limited",
        false,
    )
    .unwrap();
    for index in 0..2048 {
        let peer = IpAddr::V4(std::net::Ipv4Addr::from(0xc000_0200u32 + index));
        attempt_budget(
            &mut budgets,
            &ClientSource::legacy(Some(peer)),
            1900,
            900,
            10,
            "login_rate_limited",
            false,
        )
        .unwrap();
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
    let (response, events) = sign_in_audit_tests::captured(request(
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
    ))
    .await;
    sign_in_audit_tests::failure(&events, "authorization_unavailable", auth.now(), None);
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
                ClientSource::legacy(Some(peer)),
                AttemptBudget {
                    window: auth.now(),
                    count: login_count,
                },
            );
            inner.factor_budgets.insert(
                ClientSource::legacy(Some(peer)),
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

mod sign_in_audit_tests {
    use super::*;
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::{Layer, layer::Context, prelude::*};

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<BTreeMap<String, String>>>>);

    struct Fields(BTreeMap<String, String>);
    impl tracing::field::Visit for Fields {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            self.0.insert(field.name().into(), format!("{value:?}"));
        }
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            self.0.insert(field.name().into(), value.into());
        }
        fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
            self.0.insert(field.name().into(), value.to_string());
        }
    }
    impl<S: tracing::Subscriber> Layer<S> for Capture {
        fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
            if event.metadata().target() == "agent_connect_gateway::owner_sign_in" {
                let mut fields = Fields(BTreeMap::new());
                event.record(&mut fields);
                self.0.lock().unwrap().push(fields.0);
            }
        }
    }
    pub(super) async fn captured<F: std::future::Future>(
        future: F,
    ) -> (F::Output, Vec<BTreeMap<String, String>>) {
        // tracing-core's JustOne first-registration shortcut consults the
        // current thread's default. An unrelated, uncaptured test can reach
        // the callsite while this future awaits, incorrectly caching "never".
        // Keep two live registrars so it consults registered subscribers;
        // this inert dispatcher is never installed as a default or global.
        let _inert = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
        let capture = Capture::default();
        let result = future
            .with_subscriber(tracing_subscriber::registry().with(capture.clone()))
            .await;
        let events = capture.0.lock().unwrap().clone();
        (result, events)
    }
    pub(super) fn failure(
        events: &[BTreeMap<String, String>],
        code: &str,
        at: u64,
        entry: Option<&str>,
    ) {
        assert_eq!(
            events.len(),
            1,
            "Exactly one audit event per failed sign-in"
        );
        let mut expected = BTreeMap::from([
            ("event".into(), "owner_sign_in_failed".into()),
            ("message".into(), "Owner sign-in failed".into()),
            ("reason".into(), code.into()),
            ("at".into(), at.to_string()),
        ]);
        if let Some(entry) = entry {
            expected.insert("entry_point".into(), entry.into());
        }
        assert_eq!(events[0], expected);
    }
    fn history(auth: &AuthService) -> Vec<pages::SignInFailure> {
        auth.sign_in_audit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .recent(auth.now())
    }

    #[tokio::test]
    async fn audit_sign_in_records_each_form_rejection_once_without_submitted_values() {
        let fixture = Fixture::new();
        let auth = &fixture.auth;
        let marker = "private-marker-not-for-audit";
        for (case, status, reason) in [
            ("missing", StatusCode::FORBIDDEN, "missing_session_cookie"),
            (
                "duplicate",
                StatusCode::FORBIDDEN,
                "duplicate_session_cookie",
            ),
            (
                "malformed",
                StatusCode::FORBIDDEN,
                "invalid_or_expired_session",
            ),
            (
                "unknown",
                StatusCode::FORBIDDEN,
                "invalid_or_expired_session",
            ),
            ("csrf", StatusCode::FORBIDDEN, "invalid_csrf"),
            ("origin", StatusCode::FORBIDDEN, "invalid_owner_origin"),
            ("form", StatusCode::BAD_REQUEST, "invalid_request"),
            ("query", StatusCode::BAD_REQUEST, "invalid_request"),
            (
                "passphrase",
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
            ),
            ("factor", StatusCode::BAD_REQUEST, "invalid_factor"),
            (
                "login_budget",
                StatusCode::TOO_MANY_REQUESTS,
                "login_rate_limited",
            ),
            (
                "factor_budget",
                StatusCode::TOO_MANY_REQUESTS,
                "factor_rate_limited",
            ),
        ] {
            let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
            let anonymous = cookie(&page);
            let cookie_value = match case {
                "duplicate" => format!("{anonymous}; {anonymous}"),
                "malformed" => "__Host-agent_connect_owner=".into(),
                "unknown" => format!("__Host-agent_connect_owner={marker}"),
                _ => anonymous,
            };
            {
                let mut inner = auth.inner.lock().unwrap();
                inner.stored.totp_secret =
                    matches!(case, "factor" | "factor_budget").then(|| base32(&[9; 20]));
                if case == "login_budget" {
                    inner.login_budgets.insert(
                        ClientSource::legacy(None),
                        AttemptBudget {
                            window: auth.now(),
                            count: 10,
                        },
                    );
                }
                if case == "factor_budget" {
                    inner.factor_budgets.insert(
                        ClientSource::legacy(None),
                        AttemptBudget {
                            window: auth.now(),
                            count: 5,
                        },
                    );
                }
            }
            let csrf_token = input(&page.text, "csrf_token");
            let mut fields = vec![
                (
                    "csrf_token",
                    if case == "csrf" {
                        marker
                    } else {
                        csrf_token.as_str()
                    },
                ),
                (
                    "passphrase",
                    if case == "passphrase" {
                        marker
                    } else {
                        PASSWORD
                    },
                ),
                ("totp", marker),
            ];
            if case == "form" {
                fields.push(("unrecognized", marker));
            }
            let path = if case == "query" {
                format!("{LOGIN}?{marker}")
            } else {
                LOGIN.to_string()
            };
            let (reply, events) = captured(request_at(
                auth,
                Method::POST,
                &path,
                Some(if case == "origin" {
                    "https://private-marker-not-for-audit.example"
                } else {
                    ISSUER
                }),
                if case == "missing" {
                    None
                } else {
                    Some(&cookie_value)
                },
                Some("gateway.example"),
                &fields,
            ))
            .await;
            assert_eq!(reply.status, status, "{case}");
            failure(&events, reason, auth.now(), Some(ISSUER));
            assert!(!format!("{events:?}").contains(marker));
            let recent = history(auth);
            assert_eq!(recent.last().unwrap().at, 1_700_000_000);
            assert!(recent.iter().all(|row| !row.reason.contains(marker)));
            let mut inner = auth.inner.lock().unwrap();
            inner.login_budgets.clear();
            inner.factor_budgets.clear();
            inner.stored.totp_secret = None;
        }
        let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
        advance(auth, 601);
        let (reply, events) = captured(request_at(
            auth,
            Method::POST,
            LOGIN,
            Some(ISSUER),
            Some(&cookie(&page)),
            Some("gateway.example"),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("passphrase", PASSWORD),
            ],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        failure(
            &events,
            "invalid_or_expired_session",
            auth.now(),
            Some(ISSUER),
        );
        assert_eq!(history(auth).len(), 13);
    }

    #[tokio::test]
    async fn audit_sign_in_covers_body_concurrency_global_and_unavailable_boundaries() {
        let fixture = Fixture::new();
        let auth = &fixture.auth;
        let oversized = axum::http::Request::builder()
            .method(Method::POST)
            .uri(LOGIN)
            .header(header::HOST, "gateway.example")
            .header(header::ORIGIN, "https://secret-origin.example")
            .header(header::COOKIE, "secret-cookie")
            .body(Body::from("secret-body".repeat(MAX_BODY)))
            .unwrap();
        let (reply, events) = captured(auth.clone().router().oneshot(oversized)).await;
        assert_eq!(reply.unwrap().status(), StatusCode::BAD_REQUEST);
        failure(&events, "invalid_body", auth.now(), Some(ISSUER));
        let permits = auth.requests.acquire_many(32).await.unwrap();
        let (reply, events) = captured(request_at(
            auth,
            Method::POST,
            LOGIN,
            None,
            None,
            Some("gateway.example"),
            &[],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
        failure(&events, "concurrency_limited", auth.now(), Some(ISSUER));
        drop(permits);
        {
            let mut inner = auth.inner.lock().unwrap();
            inner.rate_count = 600;
            inner.rate_window = auth.now();
        }
        let (reply, events) = captured(request_at(
            auth,
            Method::POST,
            LOGIN,
            None,
            None,
            Some("gateway.example"),
            &[],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
        failure(&events, "request_rate_limited", auth.now(), Some(ISSUER));
        auth.inner.lock().unwrap().broken = true;
        let (reply, events) = captured(request_at(
            auth,
            Method::POST,
            LOGIN,
            None,
            None,
            Some("gateway.example"),
            &[],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        failure(
            &events,
            "authorization_unavailable",
            auth.now(),
            Some(ISSUER),
        );
        assert_eq!(history(auth).len(), 4);
    }

    #[tokio::test]
    async fn audit_sign_in_covers_session_capacity_and_poisoned_authorization_state() {
        let fixture = Fixture::new();
        let auth = &fixture.auth;
        let page = request(auth, Method::GET, LOGIN, None, None, &[]).await;
        {
            let mut inner = auth.inner.lock().unwrap();
            for index in 0..MAX_TRANSIENT {
                inner.sessions.insert(
                    format!("fixture-owner-{index}"),
                    Session {
                        source: None,
                        origin: ISSUER.into(),
                        expires: auth.now() + 3600,
                        owner: true,
                        enrollment: None,
                    },
                );
            }
        }
        let (reply, events) = captured(request(
            auth,
            Method::POST,
            LOGIN,
            Some(ISSUER),
            Some(&cookie(&page)),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("passphrase", PASSWORD),
            ],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        failure(&events, "authorization_capacity", auth.now(), None);
        assert!(!reply.headers.contains_key(header::SET_COOKIE));
        assert_eq!(auth.inner.lock().unwrap().sessions.len(), MAX_TRANSIENT);
        let poisoned = auth.clone();
        assert!(
            std::thread::spawn(move || {
                let _guard = poisoned.inner.lock().unwrap();
                panic!("synthetic authorization lock failure");
            })
            .join()
            .is_err()
        );
        let (reply, events) =
            captured(request(auth, Method::POST, LOGIN, Some(ISSUER), None, &[])).await;
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        failure(&events, "authorization_unavailable", auth.now(), None);
        assert_eq!(history(auth).len(), 2);
    }

    #[tokio::test]
    async fn audit_sign_in_attribution_uses_only_strict_configured_hosts() {
        let dir = std::env::temp_dir().join(random("agent-connect-audit-test-"));
        let mut configuration = config(dir.clone(), Some(PASSWORD));
        configuration
            .entry_points
            .push("https://second.example:9443".into());
        let fixture = Fixture {
            dir,
            auth: AuthService::open(configuration).unwrap(),
        };
        let auth = &fixture.auth;
        for (hosts, entry) in [
            (vec!["gateway.example"], Some(ISSUER)),
            (
                vec!["second.example:9443"],
                Some("https://second.example:9443"),
            ),
            (vec![], None),
            (vec!["secret-host.example"], None),
            (vec!["gateway.example", "gateway.example"], None),
            (vec!["second.example"], None),
        ] {
            let mut builder = axum::http::Request::builder()
                .method(Method::POST)
                .uri(LOGIN)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header(header::ORIGIN, entry.unwrap_or(ISSUER))
                .header("x-forwarded-host", "secret-forwarded.example")
                .header("x-forwarded-proto", "secret-proto");
            for host in &hosts {
                builder = builder.header(header::HOST, *host);
            }
            let (reply, events) = captured(
                auth.clone()
                    .router()
                    .oneshot(builder.body(Body::empty()).unwrap()),
            )
            .await;
            let expected = if hosts.is_empty() || entry.is_some() {
                "missing_session_cookie"
            } else {
                "invalid_target"
            };
            assert!(reply.unwrap().status().is_client_error());
            failure(&events, expected, auth.now(), entry);
            assert!(!format!("{events:?}").contains("secret-"));
            assert_eq!(history(auth)[0].entry_point.as_deref(), entry);
        }
    }

    #[tokio::test]
    async fn audit_sign_in_ignores_success_get_and_other_endpoints() {
        let fixture = Fixture::new();
        let auth = &fixture.auth;
        let (page, events) = captured(request(auth, Method::GET, LOGIN, None, None, &[])).await;
        assert_eq!(page.status, StatusCode::OK);
        assert!(events.is_empty());
        let (signed_in, events) = captured(request(
            auth,
            Method::POST,
            LOGIN,
            Some(ISSUER),
            Some(&cookie(&page)),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("passphrase", PASSWORD),
            ],
        ))
        .await;
        assert_eq!(signed_in.status, StatusCode::FOUND);
        assert!(events.is_empty());
        for (method, path) in [
            (Method::GET, "/agent-connect/owner/login?invalid=secret"),
            (Method::POST, AUTHORIZE),
            (Method::POST, "/agent-connect/owner/logout"),
        ] {
            let (reply, events) =
                captured(request(auth, method, path, Some(ISSUER), None, &[])).await;
            assert!(reply.status.is_client_error());
            assert!(events.is_empty());
        }
        assert!(history(auth).is_empty());
    }

    #[tokio::test]
    async fn audit_sign_in_history_is_bounded_expires_and_does_not_persist() {
        let dir = std::env::temp_dir().join(random("agent-connect-audit-restart-test-"));
        struct Directory(PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _directory = Directory(dir.clone());
        let auth = AuthService::open(config(dir.clone(), Some(PASSWORD))).unwrap();
        let (_, events) = captured(async {
            for _ in 0..65 {
                assert_eq!(
                    request(&auth, Method::POST, LOGIN, Some(ISSUER), None, &[])
                        .await
                        .status,
                    StatusCode::FORBIDDEN
                );
                advance(&auth, 1);
            }
        })
        .await;
        assert_eq!(events.len(), 65);
        let recent = history(&auth);
        assert_eq!(recent.len(), 64);
        assert_eq!(recent[0].at, 1_700_000_064);
        assert_eq!(recent[63].at, 1_700_000_001);
        advance(&auth, 24 * 3600 - 1);
        assert!(history(&auth).is_empty());
        request(&auth, Method::POST, LOGIN, Some(ISSUER), None, &[]).await;
        assert_eq!(history(&auth).len(), 1);
        drop(auth);
        let restarted = AuthService::open(config(dir.clone(), None)).unwrap();
        assert!(history(&restarted).is_empty());
        let stored = fs::read_to_string(dir.join("authorization.json")).unwrap();
        assert!(!stored.contains("sign_in"));
    }

    #[tokio::test]
    async fn audit_sign_in_poisoned_observer_does_not_change_authentication_response() {
        let fixture = Fixture::new();
        let auth = fixture.auth.clone();
        let poisoned = auth.clone();
        assert!(
            std::thread::spawn(move || {
                let _guard = poisoned.sign_in_audit.lock().unwrap();
                panic!("synthetic observer failure");
            })
            .join()
            .is_err()
        );
        let (reply, events) =
            captured(request(&auth, Method::POST, LOGIN, Some(ISSUER), None, &[])).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        failure(&events, "missing_session_cookie", auth.now(), None);
        assert_eq!(history(&auth).len(), 1);
    }

    #[tokio::test]
    async fn audit_sign_in_pauses_use_budget_windows_latest_reset_and_owner_exemption() {
        let fixture = Fixture::new();
        let auth = &fixture.auth;
        let owner = login(auth, "").await;
        let now = auth.now();
        {
            let mut inner = auth.inner.lock().unwrap();
            for (index, age, count) in [(1, 10, 10), (2, 100, 10), (3, 901, 10), (4, 0, 9)] {
                inner.login_budgets.insert(
                    ClientSource::legacy(Some(format!("192.0.2.{index}").parse().unwrap())),
                    AttemptBudget {
                        window: now - age,
                        count,
                    },
                );
            }
            for (index, age, count) in [(1, 5, 5), (2, 50, 5), (3, 61, 5), (4, 0, 4)] {
                inner.factor_budgets.insert(
                    ClientSource::legacy(Some(format!("192.0.2.{index}").parse().unwrap())),
                    AttemptBudget {
                        window: now - age,
                        count,
                    },
                );
            }
            inner.rate_window = now - 20;
            inner.rate_count = 600;
            let pauses = sign_in_audit::pauses(&inner, now);
            assert_eq!(pauses.len(), 3);
            assert_eq!(
                (pauses[0].label, pauses[0].affected_clients, pauses[0].until),
                ("Sign-in attempts", Some(2), now + 890)
            );
            assert_eq!(
                (pauses[1].label, pauses[1].affected_clients, pauses[1].until),
                ("Authenticator attempts", Some(2), now + 55)
            );
            assert_eq!(
                (pauses[2].label, pauses[2].affected_clients, pauses[2].until),
                ("Unauthenticated requests", None, now + 40)
            );
        }
        let (page, events) =
            captured(request(auth, Method::GET, OWNER, None, Some(&owner), &[])).await;
        assert_eq!(page.status, StatusCode::OK);
        assert!(events.is_empty());
        assert!(!page.text.contains("192.0.2."));
        let (reply, events) =
            captured(request(auth, Method::POST, LOGIN, Some(ISSUER), None, &[])).await;
        assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
        failure(&events, "request_rate_limited", now, None);
        advance(auth, 40);
        assert_eq!(
            sign_in_audit::pauses(&auth.inner.lock().unwrap(), auth.now()).len(),
            2
        );
        advance(auth, 15);
        assert_eq!(
            sign_in_audit::pauses(&auth.inner.lock().unwrap(), auth.now()).len(),
            1
        );
        advance(auth, 835);
        assert!(sign_in_audit::pauses(&auth.inner.lock().unwrap(), auth.now()).is_empty());
    }
}

mod client_address_tests {
    use super::*;
    const SECOND: &str = "https://second.example";
    const META: &str = "/.well-known/oauth-authorization-server/agent-connect";
    const PROXY: &str = "192.0.2.10";
    const CLIENT: &str = "198.51.100.7";
    const OTHER: &str = "198.51.100.8";
    fn fixture() -> Fixture {
        let dir = std::env::temp_dir().join(random("agent-connect-proxy-test-"));
        let mut configuration = config(dir.clone(), Some(PASSWORD));
        configuration.entry_points = vec![SECOND.into(), "https://direct.example".into()];
        configuration.client_address_policies = serde_json::from_value(json!({
            ISSUER: {"header":"x-client-ip", "trusted_peers":[PROXY]},
            SECOND: {"header":"x-other-ip", "trusted_peers":[PROXY]},
        }))
        .unwrap();
        Fixture {
            dir,
            auth: AuthService::open(configuration).unwrap(),
        }
    }
    fn source(origin: &str, ip: &str) -> ClientSource {
        ClientSource::Trusted(origin.into(), ip.parse().unwrap())
    }
    async fn send(
        auth: &Arc<AuthService>,
        method: Method,
        path: &str,
        origin: &str,
        peer: Option<&str>,
        values: &[(&str, &str)],
        cookie: Option<&str>,
        fields: &[(&str, &str)],
    ) -> Reply {
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(
                header::HOST,
                Url::parse(origin).unwrap().host_str().unwrap(),
            )
            .header(header::ORIGIN, origin);
        if let Some(peer) = peer {
            req = req.extension(ConnectInfo(SocketAddr::new(peer.parse().unwrap(), 12345)));
        }
        for (name, value) in values {
            req = req.header(*name, *value);
        }
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        let response = auth
            .clone()
            .router()
            .oneshot(
                req.body(Body::from(serde_urlencoded::to_string(fields).unwrap()))
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
    async fn get(
        auth: &Arc<AuthService>,
        path: &str,
        origin: &str,
        ip: &str,
        cookie: Option<&str>,
    ) -> Reply {
        send(
            auth,
            Method::GET,
            path,
            origin,
            Some(PROXY),
            &[(
                if origin == SECOND {
                    "x-other-ip"
                } else {
                    "x-client-ip"
                },
                ip,
            )],
            cookie,
            &[],
        )
        .await
    }
    fn owner(auth: &AuthService) -> String {
        let token = random("synthetic-owner-");
        auth.inner.lock().unwrap().sessions.insert(
            hash(&token),
            Session {
                source: None,
                origin: ISSUER.into(),
                expires: auth.now() + 3600,
                owner: true,
                enrollment: None,
            },
        );
        format!("__Host-agent_connect_owner={token}")
    }
    fn owner_id(cookie: &str) -> String {
        hash(cookie.split_once('=').unwrap().1)
    }

    #[tokio::test]
    async fn client_address_disabled_keeps_global_limits_and_old_session_eviction() {
        let fixture = Fixture::new();
        let auth = &fixture.auth;
        let first = request(auth, Method::GET, LOGIN, None, None, &[]).await;
        let first_id = owner_id(&cookie(&first));
        advance(auth, 1);
        for _ in 0..MAX_TRANSIENT {
            assert_eq!(
                send(
                    auth,
                    Method::GET,
                    LOGIN,
                    ISSUER,
                    Some(PROXY),
                    &[("x-client-ip", CLIENT)],
                    None,
                    &[]
                )
                .await
                .status,
                StatusCode::OK
            );
            advance(auth, 1);
        }
        let inner = auth.inner.lock().unwrap();
        assert_eq!(inner.anonymous.len(), MAX_TRANSIENT);
        assert!(!inner.anonymous.contains_key(&first_id));
        assert!(
            inner
                .anonymous
                .values()
                .all(|session| session.source.is_none())
        );
        assert!(inner.request_budgets.is_empty());
    }

    #[tokio::test]
    async fn client_address_request_limits_partition_origins_and_stop_before_global_count() {
        let fixture = fixture();
        let auth = &fixture.auth;
        for (origin, ip) in [(ISSUER, CLIENT), (ISSUER, OTHER), (SECOND, CLIENT)] {
            for _ in 0..CLIENT_REQUEST_LIMIT {
                assert_eq!(
                    get(auth, META, origin, ip, None).await.status,
                    StatusCode::OK
                );
            }
            let before = auth.inner.lock().unwrap().rate_count;
            for _ in 0..3 {
                assert_eq!(
                    get(auth, META, origin, ip, None).await.status,
                    StatusCode::TOO_MANY_REQUESTS
                );
            }
            assert_eq!(auth.inner.lock().unwrap().rate_count, before);
        }
        assert_eq!(auth.inner.lock().unwrap().rate_count, 180);
        let owner = owner(auth);
        assert_eq!(
            get(auth, OWNER, ISSUER, CLIENT, Some(&owner)).await.status,
            StatusCode::OK
        );
        auth.inner.lock().unwrap().rate_count = 600;
        assert_eq!(
            get(auth, OWNER, ISSUER, CLIENT, Some(&owner)).await.status,
            StatusCode::OK
        );
        assert_eq!(
            get(auth, META, ISSUER, "198.51.100.9", None).await.status,
            StatusCode::TOO_MANY_REQUESTS
        );
        advance(auth, 60);
        assert_eq!(
            get(auth, META, ISSUER, CLIENT, None).await.status,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn client_address_fallback_and_transport_groups_ignore_spoofed_headers() {
        let fixture = fixture();
        let auth = &fixture.auth;
        for headers in [
            vec![],
            vec![("x-client-ip", "bad-secret-value")],
            vec![("x-client-ip", CLIENT), ("x-client-ip", OTHER)],
            vec![("x-client-ip", "198.51.100.7, 198.51.100.8")],
        ] {
            assert_eq!(
                send(
                    auth,
                    Method::GET,
                    META,
                    ISSUER,
                    Some(PROXY),
                    &headers,
                    None,
                    &[]
                )
                .await
                .status,
                StatusCode::OK
            );
        }
        for peer in [None, Some("192.0.2.11")] {
            for ip in [CLIENT, OTHER] {
                assert_eq!(
                    send(
                        auth,
                        Method::GET,
                        META,
                        ISSUER,
                        peer,
                        &[("x-client-ip", ip)],
                        None,
                        &[]
                    )
                    .await
                    .status,
                    StatusCode::OK
                );
            }
        }
        assert_eq!(
            get(auth, META, "https://direct.example", CLIENT, None)
                .await
                .status,
            StatusCode::OK
        );
        {
            let inner = auth.inner.lock().unwrap();
            assert_eq!(
                inner.request_budgets[&ClientSource::Missing(ISSUER.into())].count,
                4
            );
            assert_eq!(
                inner.request_budgets[&ClientSource::Transport(None)].count,
                2
            );
            assert_eq!(
                inner.request_budgets
                    [&ClientSource::Transport(Some("192.0.2.11".parse().unwrap()))]
                    .count,
                2
            );
            assert_eq!(
                inner.request_budgets[&ClientSource::Transport(Some(PROXY.parse().unwrap()))].count,
                1
            );
        }
        let before = auth.inner.lock().unwrap().rate_count;
        assert_eq!(
            send(
                auth,
                Method::GET,
                META,
                "https://unknown.example",
                Some(PROXY),
                &[
                    ("x-forwarded-host", "gateway.example"),
                    ("x-client-ip", CLIENT)
                ],
                None,
                &[]
            )
            .await
            .status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            send(
                auth,
                Method::GET,
                META,
                ISSUER,
                Some(PROXY),
                &[("host", "gateway.example"), ("x-client-ip", CLIENT)],
                None,
                &[]
            )
            .await
            .status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(auth, Method::GET, META, None, None, &[])
                .await
                .status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(auth.inner.lock().unwrap().rate_count, before);
    }

    #[tokio::test]
    async fn client_address_session_admission_preserves_other_clients_and_reuses_cookie() {
        let fixture = fixture();
        let auth = &fixture.auth;
        let mut cookies = Vec::new();
        for _ in 0..CLIENT_SIGN_IN_LIMIT {
            let page = get(auth, LOGIN, ISSUER, CLIENT, None).await;
            assert_eq!(page.status, StatusCode::OK);
            cookies.push(cookie(&page));
        }
        let before = auth.inner.lock().unwrap().rate_count;
        assert_eq!(
            get(auth, LOGIN, ISSUER, CLIENT, None).await.status,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(auth.inner.lock().unwrap().rate_count, before);
        assert_eq!(
            get(auth, LOGIN, ISSUER, OTHER, None).await.status,
            StatusCode::OK
        );
        let reused = get(auth, LOGIN, ISSUER, OTHER, Some(&cookies[0])).await;
        assert_eq!(reused.status, StatusCode::OK);
        assert!(!reused.headers.contains_key(header::SET_COOKIE));
        // The address used for a new form or its POST is not session/CSRF authority.
        let (signed_in, events) = sign_in_audit_tests::captured(send(
            auth,
            Method::POST,
            LOGIN,
            ISSUER,
            Some(PROXY),
            &[("x-client-ip", "198.51.100.9")],
            Some(&cookies[0]),
            &[
                ("csrf_token", &input(&reused.text, "csrf_token")),
                ("continue", ""),
                ("passphrase", PASSWORD),
            ],
        ))
        .await;
        assert_eq!(signed_in.status, StatusCode::FOUND);
        assert!(events.is_empty());
        let wrong_origin = get(auth, OWNER, SECOND, OTHER, Some(&cookie(&signed_in))).await;
        assert_eq!(wrong_origin.status, StatusCode::FOUND);
        assert_eq!(wrong_origin.headers[header::LOCATION], LOGIN);
        assert!(auth.inner.lock().unwrap().stored.grants.is_empty());
        advance(auth, 600);
        assert_eq!(
            get(auth, LOGIN, ISSUER, CLIENT, None).await.status,
            StatusCode::OK
        );
        assert_eq!(auth.inner.lock().unwrap().anonymous.len(), 1);
    }

    #[tokio::test]
    async fn client_address_global_session_capacity_rejects_without_evicting_live_state() {
        let fixture = fixture();
        let auth = &fixture.auth;
        let first = get(auth, LOGIN, ISSUER, CLIENT, None).await;
        let cookie = cookie(&first);
        let id = owner_id(&cookie);
        {
            let mut inner = auth.inner.lock().unwrap();
            for i in 1..MAX_TRANSIENT {
                inner.anonymous.insert(
                    format!("synthetic-{i}"),
                    Session {
                        source: Some(source(ISSUER, &format!("198.51.100.{}", i % 250 + 1))),
                        origin: ISSUER.into(),
                        expires: auth.now() + 600,
                        owner: false,
                        enrollment: None,
                    },
                );
            }
        }
        let before = auth.inner.lock().unwrap().rate_count;
        assert_eq!(
            get(auth, LOGIN, ISSUER, "203.0.113.7", None).await.status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(auth.inner.lock().unwrap().rate_count, before);
        assert_eq!(
            get(auth, LOGIN, ISSUER, OTHER, Some(&cookie)).await.status,
            StatusCode::OK
        );
        let inner = auth.inner.lock().unwrap();
        assert_eq!(inner.anonymous.len(), MAX_TRANSIENT);
        assert!(inner.anonymous.contains_key(&id));
        assert!(
            inner
                .anonymous_csrf
                .values()
                .any(|record| record.session == id)
        );
    }

    #[test]
    fn client_address_budget_capacity_uses_bounded_overflow_without_resetting_attempts() {
        let mut budgets = HashMap::new();
        let first = source(ISSUER, CLIENT);
        for _ in 0..10 {
            attempt_budget(
                &mut budgets,
                &first,
                1000,
                900,
                10,
                "login_rate_limited",
                true,
            )
            .unwrap();
        }
        for i in 1..MAX_CLIENT_BUDGETS {
            let key = ClientSource::Trusted(
                ISSUER.into(),
                IpAddr::V6(std::net::Ipv6Addr::from(i as u128)),
            );
            attempt_budget(
                &mut budgets,
                &key,
                1000,
                900,
                10,
                "login_rate_limited",
                true,
            )
            .unwrap();
        }
        for i in 0..10 {
            let key = ClientSource::Trusted(
                ISSUER.into(),
                IpAddr::V6(std::net::Ipv6Addr::from((10000 + i) as u128)),
            );
            assert_eq!(
                attempt_budget(
                    &mut budgets,
                    &key,
                    1000,
                    900,
                    10,
                    "login_rate_limited",
                    true
                )
                .unwrap(),
                ClientSource::Overflow(Some(ISSUER.into()))
            );
        }
        assert!(
            attempt_budget(
                &mut budgets,
                &source(ISSUER, OTHER),
                1000,
                900,
                10,
                "login_rate_limited",
                true
            )
            .is_err()
        );
        assert!(
            attempt_budget(
                &mut budgets,
                &first,
                1000,
                900,
                10,
                "login_rate_limited",
                true
            )
            .is_err()
        );
        // Releasing individual slots must not reset an active overflow window.
        let released = budgets
            .keys()
            .find(|key| **key != first && !key.reserved())
            .unwrap()
            .clone();
        budgets.get_mut(&released).unwrap().window = 900;
        assert!(
            attempt_budget(
                &mut budgets,
                &source(ISSUER, "203.0.113.44"),
                1800,
                900,
                10,
                "login_rate_limited",
                true
            )
            .is_err()
        );
        assert!(!budgets.contains_key(&released));
        let missing = ClientSource::Missing(ISSUER.into());
        attempt_budget(
            &mut budgets,
            &missing,
            1000,
            900,
            10,
            "login_rate_limited",
            true,
        )
        .unwrap();
        assert_eq!(budgets.len(), MAX_CLIENT_BUDGETS + 1);
        attempt_budget(
            &mut budgets,
            &first,
            1900,
            900,
            10,
            "login_rate_limited",
            true,
        )
        .unwrap();
        assert_eq!(budgets.len(), 1);
    }

    #[tokio::test]
    async fn client_address_success_keeps_overflow_until_original_deadline() {
        let fixture = fixture();
        let auth = &fixture.auth;
        let started = auth.now();
        let released = ClientSource::Trusted(ISSUER.into(), "2001:db8::1".parse().unwrap());
        {
            let mut inner = auth.inner.lock().unwrap();
            for index in 1..=MAX_CLIENT_BUDGETS {
                let key = ClientSource::Trusted(
                    ISSUER.into(),
                    format!("2001:db8::{index:x}").parse().unwrap(),
                );
                inner.login_budgets.insert(
                    key,
                    AttemptBudget {
                        window: if index == 1 { started - 899 } else { started },
                        count: 1,
                    },
                );
            }
        }
        // A real failed POST fills overflow while every individual slot is live.
        let page = get(auth, LOGIN, ISSUER, CLIENT, None).await;
        let anonymous = cookie(&page);
        let reply = send(
            auth,
            Method::POST,
            LOGIN,
            ISSUER,
            Some(PROXY),
            &[("x-client-ip", CLIENT)],
            Some(&anonymous),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("continue", ""),
                ("passphrase", "invalid-fixture"),
            ],
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        let overflow = ClientSource::Overflow(Some(ISSUER.into()));
        assert_eq!(auth.inner.lock().unwrap().login_budgets[&overflow].count, 1);
        advance(auth, 1);
        // One individual expires before success; success must not remove the
        // overflow marker and let the next client claim that free slot.
        let page = get(auth, LOGIN, ISSUER, CLIENT, Some(&anonymous)).await;
        let (reply, events) = sign_in_audit_tests::captured(send(
            auth,
            Method::POST,
            LOGIN,
            ISSUER,
            Some(PROXY),
            &[("x-client-ip", CLIENT)],
            Some(&anonymous),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("continue", ""),
                ("passphrase", PASSWORD),
            ],
        ))
        .await;
        assert_eq!(reply.status, StatusCode::FOUND);
        assert!(events.is_empty());
        {
            let inner = auth.inner.lock().unwrap();
            assert!(!inner.login_budgets.contains_key(&released));
            assert_eq!(inner.login_budgets[&overflow].count, 0);
            assert_eq!(inner.login_budgets[&overflow].window, started);
        }
        for (elapsed, client, overflow_count) in [(0, OTHER, 1), (898, "198.51.100.9", 2)] {
            advance(auth, elapsed);
            let page = get(auth, LOGIN, ISSUER, client, None).await;
            let reply = send(
                auth,
                Method::POST,
                LOGIN,
                ISSUER,
                Some(PROXY),
                &[("x-client-ip", client)],
                Some(&cookie(&page)),
                &[
                    ("csrf_token", &input(&page.text, "csrf_token")),
                    ("continue", ""),
                    ("passphrase", "invalid-fixture"),
                ],
            )
            .await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
            let inner = auth.inner.lock().unwrap();
            assert!(!inner.login_budgets.contains_key(&source(ISSUER, client)));
            assert_eq!(inner.login_budgets[&overflow].count, overflow_count);
            assert_eq!(inner.login_budgets[&overflow].window, started);
        }
        advance(auth, 1);
        assert_eq!(auth.now(), started + 900);
        let client = "203.0.113.44";
        let page = get(auth, LOGIN, ISSUER, client, None).await;
        let reply = send(
            auth,
            Method::POST,
            LOGIN,
            ISSUER,
            Some(PROXY),
            &[("x-client-ip", client)],
            Some(&cookie(&page)),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("continue", ""),
                ("passphrase", "invalid-fixture"),
            ],
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        let inner = auth.inner.lock().unwrap();
        assert!(!inner.login_budgets.contains_key(&overflow));
        assert_eq!(inner.login_budgets[&source(ISSUER, client)].count, 1);
        assert_eq!(
            inner.login_budgets[&source(ISSUER, client)].window,
            started + 900
        );
    }

    #[tokio::test]
    async fn client_address_login_budget_and_audit_use_only_verified_nonsecret_context() {
        let fixture = fixture();
        let auth = &fixture.auth;
        auth.inner.lock().unwrap().login_budgets.insert(
            source(ISSUER, CLIENT),
            AttemptBudget {
                window: auth.now(),
                count: 10,
            },
        );
        for (ip, expected, reason) in [
            (CLIENT, StatusCode::TOO_MANY_REQUESTS, "login_rate_limited"),
            (OTHER, StatusCode::UNAUTHORIZED, "invalid_credentials"),
        ] {
            let page = get(auth, LOGIN, ISSUER, ip, None).await;
            let (reply, events) = sign_in_audit_tests::captured(send(
                auth,
                Method::POST,
                LOGIN,
                ISSUER,
                Some(PROXY),
                &[("x-client-ip", ip)],
                Some(&cookie(&page)),
                &[
                    ("csrf_token", &input(&page.text, "csrf_token")),
                    ("continue", ""),
                    ("passphrase", "secret-not-for-history"),
                ],
            ))
            .await;
            assert_eq!(reply.status, expected);
            sign_in_audit_tests::failure(&events, reason, auth.now(), Some(ISSUER));
            let rendered = format!("{events:?}{}", reply.text);
            for secret in [
                PROXY,
                CLIENT,
                OTHER,
                "secret-not-for-history",
                "x-client-ip",
            ] {
                assert!(!rendered.contains(secret));
            }
        }
        let owner = owner(auth);
        let page = get(auth, OWNER, ISSUER, CLIENT, Some(&owner)).await;
        assert!(page.text.contains("1 request source group"));
        for secret in [
            PROXY,
            CLIENT,
            OTHER,
            "secret-not-for-history",
            "x-client-ip",
        ] {
            assert!(!page.text.contains(secret));
        }
    }

    #[tokio::test]
    async fn client_address_all_factor_routes_share_selected_source_budget() {
        let fixture = fixture();
        let auth = &fixture.auth;
        let owner = owner(auth);
        let id = owner_id(&owner);
        let secret = base32(&[9; 20]);
        for (path, action, factor_enabled) in [
            ("/agent-connect/owner/totp/enroll", "enroll", false),
            ("/agent-connect/owner/totp/verify", "factor_verify", false),
            (AUTHORIZE, "consent:pending-fixture", true),
        ] {
            for (ip, expected) in [
                (CLIENT, StatusCode::TOO_MANY_REQUESTS),
                (OTHER, StatusCode::BAD_REQUEST),
            ] {
                let token = {
                    let mut inner = auth.inner.lock().unwrap();
                    inner.stored.totp_secret = factor_enabled.then(|| secret.clone());
                    inner.sessions.get_mut(&id).unwrap().enrollment =
                        Some((secret.clone(), auth.now() + 600));
                    inner.pending.insert(
                        "pending-fixture".into(),
                        Pending {
                            issuer: ISSUER.into(),
                            client: APP.into(),
                            client_name: "Fixture".into(),
                            redirect: format!("{APP}/callback"),
                            state: "fixture-state".into(),
                            challenge: hash(VERIFIER),
                            tools: vec![],
                            expires: auth.now() + 600,
                        },
                    );
                    inner.factor_budgets.insert(
                        source(ISSUER, CLIENT),
                        AttemptBudget {
                            window: auth.now(),
                            count: 5,
                        },
                    );
                    csrf(&mut inner, &id, action, auth.now())
                };
                let mut fields = vec![("csrf_token", token.as_str())];
                if path.ends_with("/enroll") {
                    fields.push(("passphrase", "invalid-fixture"));
                } else if path == AUTHORIZE {
                    fields.extend([
                        ("request_uri", "pending-fixture"),
                        ("decision", "approve"),
                        ("duration", "3600"),
                        ("profile", "sandboxed"),
                        ("totp", "invalid"),
                    ]);
                } else {
                    fields.push(("totp", "invalid"));
                }
                let reply = send(
                    auth,
                    Method::POST,
                    path,
                    ISSUER,
                    Some(PROXY),
                    &[("x-client-ip", ip)],
                    Some(&owner),
                    &fields,
                )
                .await;
                let expected = if path.ends_with("/enroll") && ip == OTHER {
                    StatusCode::UNAUTHORIZED
                } else {
                    expected
                };
                assert_eq!(reply.status, expected, "{path}: {}", reply.text);
            }
        }
        // Login factor verification uses that same bucket after passphrase success.
        let page = get(auth, LOGIN, ISSUER, CLIENT, None).await;
        let response = send(
            auth,
            Method::POST,
            LOGIN,
            ISSUER,
            Some(PROXY),
            &[("x-client-ip", CLIENT)],
            Some(&cookie(&page)),
            &[
                ("csrf_token", &input(&page.text, "csrf_token")),
                ("continue", ""),
                ("passphrase", PASSWORD),
                ("totp", "invalid"),
            ],
        )
        .await;
        assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(auth.inner.lock().unwrap().stored.grants.is_empty());
        assert_eq!(
            auth.inner.lock().unwrap().factor_budgets[&source(ISSUER, OTHER)].count,
            3
        );
    }
}
