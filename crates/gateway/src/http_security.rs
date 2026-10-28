//! Response security policy for the complete hosted gateway router.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;

use crate::authorization::AuthService;

/// Apply HSTS using the operator-configured external origin, including when TLS
/// terminates before the gateway. Wrap the fully assembled router so fallback,
/// protocol, and authorization responses receive the same policy.
pub fn with_hsts(router: Router, auth: Arc<AuthService>) -> Router {
    router.layer(middleware::from_fn_with_state(auth, hsts))
}

async fn hsts(State(auth): State<Arc<AuthService>>, request: Request, next: Next) -> Response {
    // entry_point requires exactly one known Host. In particular, neither the
    // primary origin nor client-controlled forwarding headers are fallbacks.
    let https = auth
        .entry_point(request.headers())
        .is_ok_and(|origin| origin.starts_with("https://"));
    let mut response = next.run(request).await;
    if https {
        response.headers_mut().insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    } else {
        response
            .headers_mut()
            .remove(header::STRICT_TRANSPORT_SECURITY);
    }
    response
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::body::Body;
    use axum::extract::WebSocketUpgrade;
    use axum::http::{Method, StatusCode};
    use axum::routing::get;
    use tower::ServiceExt;

    use super::*;
    use crate::Harness;
    use crate::authorization::AuthConfig;
    use crate::policy::PermissionProfile;

    struct Fixture {
        dir: PathBuf,
        auth: Arc<AuthService>,
    }

    impl Fixture {
        fn new(primary: &str, additional: &[&str]) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("agent-connect-hsts-test-{}", uuid::Uuid::new_v4()));
            let auth = AuthService::open(AuthConfig {
                public_url: primary.into(),
                state_dir: dir.clone(),
                policy_fingerprint: "hsts-test-policy".into(),
                entry_points: additional.iter().map(|origin| (*origin).into()).collect(),
                client_address_policies: Default::default(),
                profiles: vec![PermissionProfile::Sandboxed],
                default_profile: PermissionProfile::Sandboxed,
                harness: Harness::Codex,
                owner_passphrase: Some("test owner passphrase".into()),
            })
            .unwrap();
            Self { dir, auth }
        }

        fn router(&self) -> Router {
            let router = Router::new()
                .route("/healthz", get(|| async { StatusCode::OK }))
                .route(
                    "/acp",
                    get(|upgrade: WebSocketUpgrade| async { upgrade.on_upgrade(|_| async {}) }),
                )
                .merge(self.auth.clone().router());
            with_hsts(router, self.auth.clone())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn request(router: Router, method: Method, path: &str, hosts: &[&str]) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        for host in hosts {
            request = request.header(header::HOST, *host);
        }
        router
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn https_policy_covers_auth_protocol_health_and_fallback_responses() {
        let fixture = Fixture::new(
            "https://gateway.example",
            &["https://secondary.example:9443"],
        );
        for host in ["gateway.example", "secondary.example:9443"] {
            for (method, path, expected_status) in [
                (Method::GET, "/healthz", StatusCode::OK),
                (Method::GET, "/agent-connect/owner/login", StatusCode::OK),
                (
                    Method::GET,
                    "/.well-known/oauth-authorization-server/agent-connect",
                    StatusCode::OK,
                ),
                (
                    Method::GET,
                    "/.well-known/oauth-protected-resource/acp",
                    StatusCode::OK,
                ),
                (
                    Method::POST,
                    "/agent-connect/oauth/token",
                    StatusCode::BAD_REQUEST,
                ),
                (Method::GET, "/acp", StatusCode::BAD_REQUEST),
                (Method::POST, "/healthz", StatusCode::METHOD_NOT_ALLOWED),
                (Method::GET, "/missing", StatusCode::NOT_FOUND),
            ] {
                let response = request(fixture.router(), method, path, &[host]).await;
                assert_eq!(response.status(), expected_status, "{host}{path}");
                let values = response
                    .headers()
                    .get_all(header::STRICT_TRANSPORT_SECURITY);
                assert_eq!(values.iter().count(), 1, "{host}{path}");
                assert_eq!(values.iter().next().unwrap(), "max-age=31536000");
            }
        }
    }

    #[tokio::test]
    async fn only_exact_configured_https_host_selects_hsts() {
        let fixture = Fixture::new(
            "https://gateway.example",
            &[
                "https://secondary.example:9443",
                "http://127.0.0.1:7123",
                "https://127.0.0.1:7443",
            ],
        );
        for (hosts, expected_hsts) in [
            (vec!["gateway.example"], true),
            (vec!["secondary.example:9443"], true),
            (vec!["127.0.0.1:7443"], true),
            (vec!["127.0.0.1:7123"], false),
            (vec![], false),
            (vec!["unknown.example"], false),
            (vec!["secondary.example"], false),
            (vec!["gateway.example:443"], false),
            (vec!["gateway.example", "gateway.example"], false),
            (vec!["gateway.example", "127.0.0.1:7123"], false),
            (vec!["gateway.example, unknown.example"], false),
        ] {
            // Spoof both secure and insecure origins: neither direction may
            // override the origin selected from the exact configured Host.
            for (scheme, forwarded_host) in
                [("https", "gateway.example"), ("http", "127.0.0.1:7123")]
            {
                let mut request = Request::builder()
                    .uri("/healthz")
                    .header(header::ORIGIN, format!("{scheme}://{forwarded_host}"))
                    .header("x-forwarded-proto", scheme)
                    .header("x-forwarded-host", forwarded_host)
                    .header("forwarded", format!("proto={scheme};host={forwarded_host}"));
                for host in &hosts {
                    request = request.header(header::HOST, *host);
                }
                let response = fixture
                    .router()
                    .oneshot(request.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(
                    response
                        .headers()
                        .contains_key(header::STRICT_TRANSPORT_SECURITY),
                    expected_hsts,
                    "hosts={hosts:?}, forwarded scheme={scheme}"
                );
            }
        }
    }

    #[tokio::test]
    async fn secondary_https_is_independent_of_http_primary() {
        let fixture = Fixture::new("http://127.0.0.1:7123", &["https://gateway.example"]);
        for (host, expected_hsts) in [("127.0.0.1:7123", false), ("gateway.example", true)] {
            for path in ["/agent-connect/owner/login", "/missing"] {
                let response = request(fixture.router(), Method::GET, path, &[host]).await;
                assert_eq!(
                    response
                        .headers()
                        .contains_key(header::STRICT_TRANSPORT_SECURITY),
                    expected_hsts,
                    "{host}{path}"
                );
            }
        }
    }
}
