//! Ephemeral, bounded owner sign-in observations. Never stores submitted values.

use std::collections::VecDeque;

use super::{Inner, pages};

const MAX_FAILURES: usize = 64;
const RETENTION: u64 = 24 * 3600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Reason {
    MissingCookie,
    DuplicateCookie,
    InvalidSession,
    InvalidCsrf,
    InvalidOrigin,
    InvalidTarget,
    InvalidCredentials,
    InvalidFactor,
    LoginRateLimited,
    FactorRateLimited,
    RequestRateLimited,
    ConcurrencyLimited,
    InvalidBody,
    InvalidRequest,
    Capacity,
    Unavailable,
}

impl Reason {
    pub(super) fn from_error(message: &str) -> Self {
        match message {
            "missing_session_cookie" => Self::MissingCookie,
            "duplicate_session_cookie" => Self::DuplicateCookie,
            "invalid_session" | "owner_login_required" => Self::InvalidSession,
            "invalid_csrf" => Self::InvalidCsrf,
            "invalid_owner_origin" => Self::InvalidOrigin,
            "invalid_target" => Self::InvalidTarget,
            "invalid_credentials" => Self::InvalidCredentials,
            "invalid_factor" => Self::InvalidFactor,
            "login_rate_limited" => Self::LoginRateLimited,
            "factor_rate_limited" => Self::FactorRateLimited,
            "slow_down" => Self::RequestRateLimited,
            "authorization_capacity" => Self::Capacity,
            "authorization unavailable" | "runtime unavailable" => Self::Unavailable,
            _ => Self::InvalidRequest,
        }
    }

    pub(super) fn code(self) -> &'static str {
        match self {
            Self::MissingCookie => "missing_session_cookie",
            Self::DuplicateCookie => "duplicate_session_cookie",
            Self::InvalidSession => "invalid_or_expired_session",
            Self::InvalidCsrf => "invalid_csrf",
            Self::InvalidOrigin => "invalid_owner_origin",
            Self::InvalidTarget => "invalid_target",
            Self::InvalidCredentials => "invalid_credentials",
            Self::InvalidFactor => "invalid_factor",
            Self::LoginRateLimited => "login_rate_limited",
            Self::FactorRateLimited => "factor_rate_limited",
            Self::RequestRateLimited => "request_rate_limited",
            Self::ConcurrencyLimited => "concurrency_limited",
            Self::InvalidBody => "invalid_body",
            Self::InvalidRequest => "invalid_request",
            Self::Capacity => "authorization_capacity",
            Self::Unavailable => "authorization_unavailable",
        }
    }

    fn summary(self) -> &'static str {
        match self {
            Self::MissingCookie => "The sign-in session cookie was not sent.",
            Self::DuplicateCookie => "More than one sign-in session cookie was sent.",
            Self::InvalidSession => "The sign-in session was invalid or expired.",
            Self::InvalidCsrf => "The sign-in form could not be verified.",
            Self::InvalidOrigin => "The sign-in form came from an unexpected origin.",
            Self::InvalidTarget => "The sign-in request did not match a configured entry point.",
            Self::InvalidCredentials => "The owner passphrase was not accepted.",
            Self::InvalidFactor => "The authenticator code was not accepted.",
            Self::LoginRateLimited => "Sign-in attempts were temporarily paused.",
            Self::FactorRateLimited => "Authenticator attempts were temporarily paused.",
            Self::RequestRateLimited => "Unauthenticated requests were temporarily paused.",
            Self::ConcurrencyLimited => "The gateway was handling too many authorization requests.",
            Self::InvalidBody => "The sign-in request body could not be read within its limit.",
            Self::InvalidRequest => "The sign-in request could not be verified.",
            Self::Capacity => "The gateway could not create another owner session.",
            Self::Unavailable => "Owner authorization was unavailable.",
        }
    }
}

struct Failure {
    at: u64,
    reason: Reason,
    entry_point: Option<String>,
}

#[derive(Default)]
pub(super) struct Audit {
    failures: VecDeque<Failure>,
}

impl Audit {
    fn prune(&mut self, now: u64) {
        self.failures
            .retain(|failure| now.saturating_sub(failure.at) < RETENTION);
    }

    pub(super) fn record(&mut self, at: u64, reason: Reason, entry_point: Option<String>) {
        self.prune(at);
        while self.failures.len() >= MAX_FAILURES {
            self.failures.pop_front();
        }
        self.failures.push_back(Failure {
            at,
            reason,
            entry_point,
        });
    }

    pub(super) fn recent(&mut self, now: u64) -> Vec<pages::SignInFailure> {
        self.prune(now);
        self.failures
            .iter()
            .rev()
            .map(|failure| pages::SignInFailure {
                at: failure.at,
                reason: failure.reason.summary(),
                entry_point: failure.entry_point.clone(),
            })
            .collect()
    }
}

pub(super) fn pauses(inner: &Inner, now: u64) -> Vec<pages::SignInPause> {
    let mut pauses = Vec::new();
    for (label, budgets, limit, period) in [
        ("Sign-in attempts", &inner.login_budgets, 10, 900),
        ("Authenticator attempts", &inner.factor_budgets, 5, 60),
        (
            "Unauthenticated requests by source",
            &inner.request_budgets,
            super::CLIENT_REQUEST_LIMIT,
            60,
        ),
    ] {
        let resets: Vec<_> = budgets
            .values()
            .filter(|budget| budget.count >= limit)
            .map(|budget| budget.window.saturating_add(period))
            .filter(|until| *until > now)
            .collect();
        if let Some(until) = resets.iter().max() {
            pauses.push(pages::SignInPause {
                label,
                affected_clients: Some(resets.len()),
                until: *until,
            });
        }
    }
    let until = inner.rate_window.saturating_add(60);
    // The next dispatched request increments the counter before testing >600;
    // an existing owner session is exempt from this global rejection.
    if inner.rate_count >= 600 && until > now {
        pauses.push(pages::SignInPause {
            label: "Unauthenticated requests",
            affected_clients: None,
            until,
        });
    }
    pauses
}
