//! Owner-facing HTML. Rendering only: callers decide authority, mint CSRF tokens
//! and pass plain data; everything interpolated here is escaped here.

use super::{AUTHORIZE, LOGIN, OWNER, Tool, escape, hidden};
use std::fmt::Write as _;

pub(super) const SECURITY: &str = "/agent-connect/owner/security";
pub(super) const GATEWAY: &str = "/agent-connect/owner/gateway";
pub(super) const TOTP: &str = "/agent-connect/owner/totp";
pub(super) const SETUP: &str = "/agent-connect/owner/setup";

pub(super) struct Page {
    pub title: String,
    pub width: Width,
    pub bar: Bar,
    pub body: String,
    /// Per-response rules, such as access-time tracks. Hashed into the CSP.
    pub dynamic_css: String,
    /// Static page behavior, authorized by a per-response CSP hash.
    pub script: &'static str,
}

#[derive(Clone, Copy)]
pub(super) enum Width {
    Compact,
    Medium,
    Full,
}

pub(super) enum Bar {
    Plain,
    Owner { current: Tab, logout_token: String },
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Tab {
    Activity,
    Security,
    Gateway,
}

pub(super) fn document(page: &Page) -> String {
    let nav = match &page.bar {
        Bar::Plain => String::new(),
        Bar::Owner {
            current,
            logout_token,
        } => {
            let link = |tab: Tab, href: &str, label: &str| {
                format!(
                    "<a href='{href}'{}>{label}</a>",
                    if *current == tab {
                        " aria-current='page'"
                    } else {
                        ""
                    }
                )
            };
            format!(
                "<nav aria-label='Owner pages'>{}{}{}</nav><form class='sign-out' method=post action='/agent-connect/owner/logout'>{}<button class='quiet'>Sign out</button></form>",
                link(Tab::Activity, OWNER, "Activity"),
                link(Tab::Security, SECURITY, "Security"),
                link(Tab::Gateway, GATEWAY, "Gateway"),
                hidden("csrf_token", logout_token)
            )
        }
    };
    let width = match page.width {
        Width::Compact => "page page--compact",
        Width::Medium => "page page--medium",
        Width::Full => "page",
    };
    let dynamic = if page.dynamic_css.is_empty() {
        String::new()
    } else {
        format!("<style>{}</style>", page.dynamic_css)
    };
    let script = if page.script.is_empty() {
        String::new()
    } else {
        format!("<script>{}</script>", page.script)
    };
    format!(
        "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='color-scheme' content='light'><title>{} · Agent Connect</title><style>{STYLES}</style>{dynamic}</head><body><header class='bar'><div class='bar-inner'><a class='brand' href='{OWNER}'><span class='brand-mark' aria-hidden='true'></span>Agent Connect</a>{nav}</div></header><main class='{width}'>{}</main>{script}</body></html>",
        escape(&page.title),
        page.body
    )
}

fn plain(title: &str, width: Width, body: String) -> Page {
    Page {
        title: title.into(),
        width,
        bar: Bar::Plain,
        body,
        dynamic_css: String::new(),
        script: "",
    }
}

const CODE_INPUT: &str = "class='code-input' inputmode=numeric pattern='[0-9]{6}' maxlength=6 autocomplete=one-time-code";

/// How this address signs in: its passkey alone, the passphrase with a TOTP
/// code, or the passphrase alone to set up a factor.
pub(super) enum SignIn {
    Passkey(String),
    Totp,
    Setup,
}

const PASSPHRASE_INPUT: &str = "<div class='field'><label for='owner-passphrase'>Passphrase</label><input id='owner-passphrase' type=password name=passphrase autocomplete=current-password required maxlength=1024></div>";

pub(super) fn sign_in(fields: &str, method: SignIn, waiting: Option<&str>) -> Page {
    // A passkey sign-in needs no words beyond its button.
    let lede = match (&method, waiting) {
        (SignIn::Passkey(_), _) => String::new(),
        (_, Some(name)) => format!(
            "<p class='lede'>Sign in to review the request from <strong>{}</strong>.</p>",
            escape(name)
        ),
        (_, None) => String::new(),
    };
    let (form, script) = match method {
        SignIn::Passkey(options) => (
            format!(
                "<form method=post action='{LOGIN}' data-passkey='{}' data-ceremony=get>{fields}<input type=hidden name=credential value=''><p class='passkey-status hint' role='status' aria-live='polite'></p><div class='actions'><button class='wide'>Sign in with your passkey</button></div></form>",
                escape(&options)
            ),
            PASSKEY_SCRIPT,
        ),
        SignIn::Totp => (
            format!(
                "<form method=post action='{LOGIN}'>{fields}{PASSPHRASE_INPUT}<div class='field'><label for='login-totp'>Authenticator code</label><input id='login-totp' name=totp {CODE_INPUT} required></div><div class='actions'><button class='wide'>Sign in</button></div></form>"
            ),
            "",
        ),
        SignIn::Setup => (
            format!(
                "<form method=post action='{LOGIN}'>{fields}{PASSPHRASE_INPUT}<div class='actions'><button class='wide'>Continue</button></div></form>"
            ),
            "",
        ),
    };
    let mut page = plain(
        "Sign in",
        Width::Compact,
        format!("<div class='panel'><h1>Sign in</h1>{lede}{form}</div>"),
    );
    page.script = script;
    page
}

/// Enroll this address's factor. `options` is None where a passkey cannot work.
pub(super) fn setup(fields: &str, options: Option<&str>) -> Page {
    let body = match options {
        Some(options) => format!(
            "<div class='panel'><h1>Set up a passkey</h1><form method=post action='/agent-connect/owner/passkey/enroll' data-passkey='{}' data-ceremony=create>{fields}<input type=hidden name=credential value=''><p class='passkey-status hint' role='status' aria-live='polite'></p><div class='actions'><button class='wide'>Create a passkey</button><a class='button secondary wide' href='{TOTP}'>Use an authenticator app</a></div></form></div>",
            escape(options)
        ),
        None => format!(
            "<div class='panel'><h1>Set up an authenticator</h1><p class='lede'>Passkeys only work on a real domain, not a raw IP address. Open this gateway through its domain, or use an authenticator app.</p><div class='actions'><a class='button wide' href='{TOTP}'>Use an authenticator app</a></div></div>"
        ),
    };
    let mut page = plain("Set up sign-in", Width::Compact, body);
    if options.is_some() {
        page.script = PASSKEY_SCRIPT;
    }
    page
}

/// Runs the passkey ceremony for a form with `data-passkey` options, then posts
/// the credential with the form. A browser without passkeys hears so when the
/// button is pressed; without JavaScript the empty credential is refused.
const PASSKEY_SCRIPT: &str = r#"(() => {
  for (const form of document.querySelectorAll('form[data-passkey]')) {
    const status = form.querySelector('.passkey-status');
    const field = form.querySelector('input[name=credential]');
    form.addEventListener('submit', async (event) => {
      if (field.value || (event.submitter && event.submitter.value === 'deny')) return;
      event.preventDefault();
      if (!window.PublicKeyCredential || !PublicKeyCredential.parseRequestOptionsFromJSON) {
        status.textContent = 'This browser can’t use passkeys.';
        return;
      }
      status.textContent = '';
      try {
        const options = JSON.parse(form.dataset.passkey);
        const credential = form.dataset.ceremony === 'create'
          ? await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey) })
          : await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey) });
        field.value = JSON.stringify(credential.toJSON());
        form.requestSubmit(event.submitter);
      } catch {
        status.textContent = 'The passkey didn’t go through. Try again.';
      }
    });
  }
})();"#;

pub(super) struct Console {
    pub now: u64,
    pub logout_token: String,
    pub problems: Vec<(String, String)>,
    pub requests: Vec<Request>,
    /// None when the session runtime cannot report.
    pub live: Option<Vec<Live>>,
    pub events: Vec<Event>,
    pub addresses: Vec<String>,
    pub sign_in_failures: Vec<SignInFailure>,
    pub sign_in_pauses: Vec<SignInPause>,
}

pub(super) struct SignInFailure {
    pub at: u64,
    pub reason: &'static str,
    pub entry_point: Option<String>,
}

pub(super) struct SignInPause {
    pub label: &'static str,
    pub until: u64,
}

pub(super) struct Request {
    pub name: String,
    pub origin: String,
    pub href: String,
    /// The address the request was made on, when it is not this one.
    pub address: Option<String>,
    pub tools: usize,
    pub expires: u64,
}

pub(super) struct Live {
    pub name: Option<String>,
    pub origin: String,
    pub id: String,
    pub state: String,
    pub started: u64,
    pub end_token: String,
}

pub(super) struct Event {
    pub at: Option<u64>,
    pub name: Option<String>,
    pub origin: String,
    pub kind: EventKind,
}

pub(super) enum EventKind {
    Approved {
        profile: &'static str,
        tools: Vec<Tool>,
        expires: u64,
        lifetime: Option<u64>,
        state: GrantState,
    },
    Revoked,
    Expired,
}

pub(super) enum GrantState {
    Active {
        grant_id: String,
        revoke_token: String,
    },
    Paused,
    Ended,
}

pub(super) fn console(view: Console) -> Page {
    let now = view.now;
    let mut body = String::new();
    for (message, repair) in &view.problems {
        let _ = write!(
            body,
            "<div class='alert runtime-problem' role='status'><strong>{}</strong><p>{}</p></div>",
            escape(message),
            commands(repair)
        );
    }
    for (index, request) in view.requests.iter().enumerate() {
        let _ = write!(
            body,
            "<article class='request' aria-labelledby='request-{0}'><span class='dot' aria-hidden='true'></span><div><h2 id='request-{0}'>{1} <span>wants to use your agent</span></h2><p class='request-origin'>{2}</p><p class='meta'>{3} tool{4} · expires {5}{7}</p></div><a class='button' href='{6}'>Review</a></article>",
            index,
            escape(&request.name),
            origin(&request.origin),
            request.tools,
            if request.tools == 1 { "" } else { "s" },
            until(now, request.expires),
            escape(&request.href),
            request
                .address
                .as_deref()
                .map(|address| format!(" · on {}", escape(address)))
                .unwrap_or_default()
        );
    }
    let live = view.live.as_deref().unwrap_or_default();
    if view.live.is_none() {
        body.push_str("<div class='alert' role='status'><strong>Session status is unavailable.</strong><p>Check the gateway before relying on session controls.</p></div>");
    }
    body.push_str(&sign_in_security(
        now,
        &view.sign_in_failures,
        &view.sign_in_pauses,
        view.addresses.len() > 1,
    ));
    if view.requests.is_empty() && live.is_empty() && view.events.is_empty() {
        let _ = write!(
            body,
            "<section class='first-run' aria-labelledby='empty-title'><h1 id='empty-title'>No apps yet</h1><p class='lede'>Give an app this address to connect.</p>{}</section>",
            addresses(&view.addresses)
        );
        let mut page = owner_page(
            "Activity",
            Tab::Activity,
            view.logout_token,
            body,
            String::new(),
        );
        page.script = COPY_SCRIPT;
        return page;
    }
    body.push_str("<h1 class='visually-hidden'>Activity</h1>");
    let mut css = String::new();
    if !live.is_empty() {
        body.push_str("<section class='feed' aria-labelledby='feed-now'><h2 class='day' id='feed-now'>Now</h2><ol class='events'>");
        for session in live {
            // The origin, then the state when it is not plain "connected".
            let meta = [
                session.name.is_some().then(|| origin(&session.origin)),
                (!session.state.eq_ignore_ascii_case("connected")).then(|| escape(&session.state)),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
            let _ = write!(
                body,
                "<li class='event event--live'>{}<span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'>{} <span class='verb'>is connected</span></p><p class='meta'>{meta}</p></div><form class='event-action' method=post action='/agent-connect/owner/sessions/end'>{}{}<button class='quiet danger'>End session</button></form></li>",
                when(now, Some(session.started)),
                subject(&session.name, &session.origin),
                hidden("session_id", &session.id),
                hidden("csrf_token", &session.end_token)
            );
        }
        body.push_str("</ol></section>");
    }
    let mut events = view.events;
    events.sort_by_key(|event| std::cmp::Reverse(event.at.unwrap_or(0)));
    let mut open: Option<&str> = None;
    for (index, event) in events.iter().enumerate() {
        // Rolling windows, not calendar days: the server cannot know the owner's timezone.
        let group = match event.at.map(|at| now.saturating_sub(at)) {
            Some(age) if age < 86_400 => "Last 24 hours",
            Some(age) if age < 7 * 86_400 => "Last 7 days",
            _ => "Earlier",
        };
        if open != Some(group) {
            if open.is_some() {
                body.push_str("</ol></section>");
            }
            let _ = write!(
                body,
                "<section class='feed' aria-labelledby='feed-{index}'><h2 class='day' id='feed-{index}'>{group}</h2><ol class='events'>"
            );
            open = Some(group);
        }
        body.push_str(&event_row(now, index, event, &mut css));
    }
    if open.is_some() {
        body.push_str("</ol></section>");
    }
    owner_page("Activity", Tab::Activity, view.logout_token, body, css)
}

/// Sign-in failures and pauses, newest first. The address shows only when the
/// gateway has more than one.
fn sign_in_security(
    now: u64,
    failures: &[SignInFailure],
    pauses: &[SignInPause],
    several_addresses: bool,
) -> String {
    let pauses: Vec<_> = pauses.iter().filter(|pause| pause.until > now).collect();
    if failures.is_empty() && pauses.is_empty() {
        return String::new();
    }
    let mut body = String::from(
        "<section class='sign-in-security' aria-labelledby='sign-in-security-title'><h2 id='sign-in-security-title'>Sign-in failures</h2>",
    );
    if !pauses.is_empty() {
        body.push_str("<ul class='sign-in-pauses' aria-label='Active pauses'>");
        for pause in pauses {
            let _ = write!(
                body,
                "<li class='sign-in-pause'><p class='event-line'>{} · try again {}</p></li>",
                escape(pause.label),
                until(now, pause.until)
            );
        }
        body.push_str("</ul>");
    }
    if !failures.is_empty() {
        body.push_str("<ol class='events' aria-label='Recent sign-in failures'>");
        for failure in failures.iter().take(20) {
            let address = failure
                .entry_point
                .as_ref()
                .filter(|_| several_addresses)
                .map(|value| format!("<p class='meta'>{}</p>", origin(value)))
                .unwrap_or_default();
            let _ = write!(
                body,
                "<li class='event sign-in-failure'>{}<span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'>{}</p>{address}</div></li>",
                when(now, Some(failure.at)),
                escape(failure.reason)
            );
        }
        body.push_str("</ol>");
    }
    body.push_str("</section>");
    body
}

fn event_row(now: u64, index: usize, event: &Event, css: &mut String) -> String {
    let when = when(now, event.at);
    let subject = subject(&event.name, &event.origin);
    let place = secondary_origin(&event.name, &event.origin);
    match &event.kind {
        EventKind::Revoked => format!(
            "<li class='event event--ended'>{when}<span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'>{subject} <span class='verb'>revoked</span></p><p class='meta'>{place}access ended</p></div></li>"
        ),
        EventKind::Expired => format!(
            "<li class='event event--ended'>{when}<span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'>{subject} <span class='verb'>expired</span></p><p class='meta'>{place}access ended</p></div></li>"
        ),
        EventKind::Approved {
            profile,
            tools,
            expires,
            lifetime,
            state,
        } => {
            let count = format!(
                "{} tool{}",
                tools.len(),
                if tools.len() == 1 { "" } else { "s" }
            );
            let (class, status, track, action) = match state {
                GrantState::Active {
                    grant_id,
                    revoke_token,
                } => {
                    let remaining = expires.saturating_sub(now);
                    let track = match lifetime {
                        Some(total) if *total > 0 => {
                            let _ = write!(
                                css,
                                "#grant-{index} .track i{{--from:{:.4};animation-duration:{remaining}s}}",
                                (remaining as f64 / *total as f64).clamp(0.0, 1.0)
                            );
                            "<div class='track' aria-hidden='true'><i></i></div>"
                        }
                        _ => "",
                    };
                    (
                        "event--active",
                        format!(" · ends {}", until(now, *expires)),
                        track,
                        format!(
                            "<form class='event-action' method=post action='/agent-connect/owner/grants/revoke'>{}{}<button class='quiet danger'>Revoke</button></form>",
                            hidden("csrf_token", revoke_token),
                            hidden("grant_id", grant_id)
                        ),
                    )
                }
                GrantState::Paused => (
                    "event--paused",
                    " · paused: the gateway’s access options changed".into(),
                    "",
                    String::new(),
                ),
                GrantState::Ended => (
                    "event--past",
                    lifetime
                        .map(|total| format!(" · for {}", span(total)))
                        .unwrap_or_default(),
                    "",
                    String::new(),
                ),
            };
            format!(
                "<li class='event {class}' id='grant-{index}'>{when}<span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'>{subject} <span class='verb'>approved</span></p><p class='meta'>{place}{} · {count}{status}</p>{track}<details class='tools'><summary>Show {count}</summary>{}</details></div>{action}</li>",
                escape(profile),
                tool_list(tools)
            )
        }
    }
}

/// The leading time column: short, tabular, with the exact UTC time on hover.
fn when(now: u64, at: Option<u64>) -> String {
    match at {
        None => "<span class='when'>Earlier</span>".into(),
        Some(at) => {
            let age = now.saturating_sub(at);
            let short = match age {
                0..60 => "now".to_string(),
                60..3600 => format!("{}m", age / 60),
                3600..86_400 => format!("{}h", age / 3600),
                _ => format!("{}d", age / 86_400),
            };
            format!("<span class='when'>{}</span>", stamp(at, &short))
        }
    }
}

/// The app the owner approved, by its declared name when the grant recorded one.
fn subject(name: &Option<String>, value: &str) -> String {
    match name {
        Some(name) => format!("<strong>{}</strong>", escape(name)),
        None => origin(value),
    }
}

/// The exact origin in the meta line when the subject is a declared name.
fn secondary_origin(name: &Option<String>, value: &str) -> String {
    if name.is_some() {
        format!("{} · ", origin(value))
    } else {
        String::new()
    }
}

/// Plain repair text with gateway CLI commands set as code.
fn commands(text: &str) -> String {
    let mut out = escape(text);
    for command in [
        "agent-connect service status",
        "agent-connect service start",
        "agent-connect service logs",
        "agent-connect doctor",
    ] {
        out = out.replace(command, &format!("<code>{command}</code>"));
    }
    out
}

fn owner_page(title: &str, tab: Tab, logout_token: String, body: String, css: String) -> Page {
    Page {
        title: title.into(),
        width: Width::Full,
        bar: Bar::Owner {
            current: tab,
            logout_token,
        },
        body,
        dynamic_css: css,
        script: "",
    }
}

pub(super) struct Security {
    pub logout_token: String,
    pub addresses: Vec<AddressFactor>,
    /// What removing a factor asks for: the signed-in address's own factor.
    pub proof: ApprovalFactor,
    pub active_grants: usize,
    pub revoke_all_token: String,
}

pub(super) struct AddressFactor {
    pub address: String,
    pub current: bool,
    /// `Some(true)` for a passkey, `Some(false)` for an authenticator app.
    pub passkey: Option<bool>,
    /// Present when this session may remove the address's factor.
    pub remove_token: Option<String>,
}

pub(super) const REMOVE_FACTOR: &str = "/agent-connect/owner/factor/remove";

pub(super) fn security(view: Security) -> Page {
    let mut uses_passkey = false;
    let factors = view
        .addresses
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let kind = match row.passkey {
                Some(true) => "Passkey",
                Some(false) => "Authenticator app",
                None => "Not set up",
            };
            let action = match (&row.remove_token, &view.proof) {
                (Some(token), ApprovalFactor::Passkey(options)) => {
                    uses_passkey = true;
                    format!(
                        "<form method=post action='{REMOVE_FACTOR}' data-passkey='{}' data-ceremony=get>{}{}<input type=hidden name=credential value=''><button class='secondary danger'>Remove</button><p class='passkey-status hint' role='status' aria-live='polite'></p></form>",
                        escape(options),
                        hidden("csrf_token", token),
                        hidden("address", &row.address)
                    )
                }
                (Some(token), ApprovalFactor::Totp) => format!(
                    "<form method=post action='{REMOVE_FACTOR}'>{}{}<label class='visually-hidden' for='remove-totp-{index}'>Authenticator code</label><input id='remove-totp-{index}' name=totp {CODE_INPUT} placeholder='Code'><button class='secondary danger'>Remove</button></form>",
                    hidden("csrf_token", token),
                    hidden("address", &row.address)
                ),
                (None, _) if row.passkey == Some(true) => {
                    "<p class='hint'>Sign in with a passkey to remove it.</p>".to_string()
                }
                (None, _) => String::new(),
            };
            format!(
                "<div class='row'>{}<div class='row-main'><p class='row-title'>{}</p><p class='meta'>{kind}{}</p></div>{action}</div>",
                shield(row.passkey.is_some()),
                escape(&row.address),
                if row.current { " · this address" } else { "" }
            )
        })
        .collect::<String>();
    let authenticator = format!(
        "<section class='section' aria-labelledby='factors-title'><h2 id='factors-title'>Sign-in</h2><div class='list'>{factors}</div><p class='hint below'>Removing one signs that address out and disconnects its apps.</p></section>"
    );
    let revoke = match view.active_grants {
        0 => "<p class='meta'>No apps have access.</p>".to_string(),
        n => format!(
            "<form class='actions' method=post action='/agent-connect/owner/grants/revoke-all'>{}<button class='secondary danger'>{}</button></form>",
            hidden("csrf_token", &view.revoke_all_token),
            if n == 1 {
                "Revoke 1 app".to_string()
            } else {
                format!("Revoke all {n} apps")
            }
        ),
    };
    let body = format!(
        "<h1>Security</h1>{authenticator}<section class='section' aria-labelledby='apps-title'><h2 id='apps-title'>Apps</h2>{revoke}</section>"
    );
    let mut page = owner_page(
        "Security",
        Tab::Security,
        view.logout_token,
        body,
        String::new(),
    );
    if uses_passkey {
        page.script = PASSKEY_SCRIPT;
    }
    page
}

pub(super) struct Gateway {
    pub logout_token: String,
    pub harness: &'static str,
    pub addresses: Vec<String>,
    /// Label and one-line summary.
    pub profiles: Vec<(&'static str, &'static str)>,
}

pub(super) fn gateway(view: Gateway) -> Page {
    let profiles = view
        .profiles
        .iter()
        .map(|(label, summary)| {
            format!(
                "<div class='row'><div class='row-main'><p class='row-title'>{}</p><p class='meta'>{}</p></div></div>",
                escape(label),
                escape(summary)
            )
        })
        .collect::<String>();
    let body = format!(
        "<h1>Gateway</h1><section class='section' aria-labelledby='addresses-title'><h2 id='addresses-title'>Addresses</h2>{}</section><div class='list'><div class='row'><div class='row-main'><p class='row-title'>Agent: {}</p></div></div></div><section class='section' aria-labelledby='profiles-title'><h2 id='profiles-title'>Access options</h2><div class='list'>{profiles}</div></section>",
        addresses(&view.addresses),
        escape(view.harness)
    );
    let mut page = owner_page(
        "Gateway",
        Tab::Gateway,
        view.logout_token,
        body,
        String::new(),
    );
    page.script = COPY_SCRIPT;
    page
}

fn addresses(list: &[String]) -> String {
    let rows = list
        .iter()
        .map(|address| {
            format!(
                "<li><code class='address'>{0}</code><span class='copy'><button type=button class='quiet' data-copy='{0}' hidden>Copy</button><span class='copy-status' role='status' aria-live='polite'></span></span></li>",
                escape(address)
            )
        })
        .collect::<String>();
    format!("<ul class='addresses'>{rows}</ul>")
}

pub(super) fn totp_scan(secret: &str, uri: &str, fields: &str) -> Page {
    let key = secret
        .as_bytes()
        .chunks(4)
        .map(|chunk| format!("<span>{}</span>", escape(&String::from_utf8_lossy(chunk))))
        .collect::<String>();
    let mut page = plain(
        "Set up an authenticator",
        Width::Medium,
        format!(
            "<div class='panel'><h1>Set up an authenticator</h1><p class='lede'>Scan, or open it in your authenticator app.</p><div class='enroll'><figure class='qr'>{}</figure><div class='enroll-other'><a class='open-app' href='{}'>Open in authenticator app</a><details class='manual'><summary>Enter the key by hand<span class='copy-status' role='status' aria-live='polite'></span></summary><p class='key' aria-label='Setup key'>{key}</p><p class='hint'>Time-based · 6 digits · 30 seconds</p></details></div></div><form method=post action='/agent-connect/owner/totp/verify'>{fields}<div class='field'><label for='enrollment-totp'>Code</label><input id='enrollment-totp' name=totp {CODE_INPUT} required></div><div class='actions actions--end'><button>Turn on</button><a class='button secondary' href='{SETUP}'>Back</a></div></form></div>",
            qr(uri),
            escape(uri)
        ),
    );
    page.script = COPY_SCRIPT;
    page
}

/// Clipboard copy for the setup key and gateway addresses. Pages work without it:
/// the key and addresses stay selectable and Copy buttons stay hidden.
const COPY_SCRIPT: &str = r#"(() => {
  const copy = async (text, status) => {
    clearTimeout(status.timer);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied';
      status.classList.remove('copied');
      void status.offsetWidth;
      status.classList.add('copied');
    } catch {
      status.textContent = 'Copy unavailable';
    }
    status.timer = setTimeout(() => { status.textContent = ''; }, 3000);
  };
  const manual = document.querySelector('.manual');
  if (manual) {
    manual.querySelector('summary').addEventListener('click', () =>
      copy(manual.querySelector('.key').textContent, manual.querySelector('.copy-status')));
  }
  for (const button of document.querySelectorAll('button[data-copy]')) {
    button.hidden = false;
    button.addEventListener('click', () => copy(button.dataset.copy, button.nextElementSibling));
  }
})();"#;

pub(super) struct Consent {
    pub name: String,
    pub origin: String,
    pub tools: Vec<Tool>,
    pub fields: String,
    pub profiles: Vec<ProfileChoice>,
    pub factor: ApprovalFactor,
}

/// What approving takes on this address: a fresh passkey assertion or code.
pub(super) enum ApprovalFactor {
    Passkey(String),
    Totp,
}

pub(super) struct ProfileChoice {
    pub value: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
    pub selected: bool,
}

const DURATIONS: [(u64, &str); 4] = [
    (3600, "1 hour"),
    (86_400, "1 day"),
    (604_800, "7 days"),
    (2_592_000, "30 days"),
];

pub(super) fn consent(view: Consent) -> Page {
    let durations = DURATIONS
        .iter()
        .enumerate()
        .map(|(index, (seconds, label))| {
            format!(
                "<label><input type=radio name=duration value={seconds}{}>{label}</label>",
                if index == 0 { " checked" } else { "" }
            )
        })
        .collect::<String>();
    let profiles = view
        .profiles
        .iter()
        .map(|profile| {
            format!(
                "<label class='option'><input type=radio name=profile value='{}'{}><span class='radio' aria-hidden='true'></span><span><strong>{}</strong><span class='meta'>{}</span></span></label>",
                profile.value,
                if profile.selected { " checked" } else { "" },
                escape(profile.label),
                escape(profile.summary)
            )
        })
        .collect::<String>();
    let (factor, passkey) = match &view.factor {
        ApprovalFactor::Totp => (
            format!(
                "<div class='field'><label for='approval-totp'>Authenticator code</label><input id='approval-totp' name=totp {CODE_INPUT} aria-describedby='approval-help'><p id='approval-help' class='hint'>Needed to approve, not to deny.</p></div>"
            ),
            String::new(),
        ),
        ApprovalFactor::Passkey(options) => (
            "<input type=hidden name=credential value=''><p class='passkey-status hint' role='status' aria-live='polite'></p>".to_string(),
            format!(" data-passkey='{}' data-ceremony=get", escape(options)),
        ),
    };
    let mut page = plain(
        &format!("Allow {}?", view.name),
        Width::Full,
        format!(
            "<header class='consent-head'><h1>Allow <span class='app' title='{}'>{}</span> to use your agent?</h1><p class='from'>from <span class='origin-chip'>{}</span></p></header><section class='block' aria-labelledby='tools-title'><h2 id='tools-title'>Tools</h2>{}</section><form class='decision' method=post action='{AUTHORIZE}'{passkey}>{}<fieldset class='segmented'><legend>Access lasts</legend><div class='opts'>{durations}</div></fieldset><fieldset class='options'><legend>Your agent’s own tools</legend>{profiles}</fieldset><div class='fineprint'><p>An approved app can use your agent’s login and see other apps’ conversations.</p></div><div class='decide'>{factor}<div class='decide-actions'><button name=decision value=approve>Approve</button><button class='secondary' name=decision value=deny>Deny</button></div></div></form>",
            escape(&view.name),
            escape(&shorten(&view.name, 48)),
            escape(&view.origin),
            tool_list(&view.tools),
            view.fields
        ),
    );
    page.width = Width::Full;
    if matches!(view.factor, ApprovalFactor::Passkey(_)) {
        page.script = PASSKEY_SCRIPT;
    }
    page
}

pub(super) fn error(title: &str, message: &str, target: &str, label: &str) -> Page {
    plain(
        title,
        Width::Compact,
        format!(
            "<div class='panel'><h1>{}</h1>{}<div class='actions'><a class='button wide' href='{}'>{}</a></div></div>",
            escape(title),
            if message.is_empty() {
                String::new()
            } else {
                format!("<p class='lede' role='alert'>{}</p>", commands(message))
            },
            escape(target),
            escape(label)
        ),
    )
}

/// Bound an app-declared name so it cannot push the exact origin out of view.
fn shorten(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.to_string()
    } else {
        format!(
            "{}…",
            value.chars().take(limit - 1).collect::<String>().trim_end()
        )
    }
}

fn tool_list(tools: &[Tool]) -> String {
    let items = tools
        .iter()
        .map(|tool| {
            format!(
                "<li><details><summary><span class='tool-text'><code>{0}</code><span>{1}</span></span></summary><pre tabindex='0' role='region' aria-label='Input schema for {0}'>{2}</pre></details></li>",
                escape(&tool.name),
                escape(&tool.description),
                escape(&serde_json::to_string_pretty(&tool.schema).expect("serializable schema"))
            )
        })
        .collect::<String>();
    format!("<ul class='tool-list'>{items}</ul>")
}

/// An exact origin with its scheme de-emphasised; the full value stays in the text.
fn origin(value: &str) -> String {
    let (scheme, rest) = value
        .split_once("://")
        .map(|(scheme, rest)| (format!("{scheme}://"), rest))
        .unwrap_or_default();
    let rest = if scheme.is_empty() { value } else { rest };
    format!(
        "<span class='origin'><span class='scheme'>{}</span>{}</span>",
        escape(&scheme),
        escape(rest)
    )
}

fn shield(on: bool) -> String {
    format!(
        "<svg class='icon{}' viewBox='0 0 24 24' aria-hidden='true'><path d='M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linejoin='round'/>{}</svg>",
        if on { " icon--on" } else { "" },
        if on {
            "<path d='M9 12l2 2 4-4' fill='none' stroke='currentColor' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/>"
        } else {
            "<path d='M12 8v4.5M12 16h.01' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'/>"
        }
    )
}

fn qr(text: &str) -> String {
    let code = qrcodegen::QrCode::encode_text(text, qrcodegen::QrCodeEcc::Medium)
        .expect("otpauth URI fits a QR code");
    let border = 4;
    let size = code.size() + 2 * border;
    let mut path = String::new();
    for y in 0..code.size() {
        for x in 0..code.size() {
            if code.get_module(x, y) {
                let _ = write!(path, "M{},{}h1v1h-1z", x + border, y + border);
            }
        }
    }
    format!(
        "<svg viewBox='0 0 {size} {size}' role='img' aria-label='QR code for adding Agent Connect to an authenticator' shape-rendering='crispEdges'><rect width='{size}' height='{size}' fill='#fff'/><path d='{path}' fill='#202d2c'/></svg>"
    )
}

fn span(seconds: u64) -> String {
    let (value, unit) = match seconds {
        0..60 => return "under a minute".into(),
        60..3600 => (seconds / 60, "min"),
        3600..86_400 => (seconds / 3600, "h"),
        _ => (
            seconds / 86_400,
            if seconds < 2 * 86_400 { "day" } else { "days" },
        ),
    };
    format!("{value} {unit}")
}

fn until(now: u64, at: u64) -> String {
    stamp(at, &format!("in {}", span(at.saturating_sub(now))))
}

fn stamp(at: u64, text: &str) -> String {
    let (year, month, day, hour, minute, second) = civil(at);
    format!(
        "<time datetime='{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z' title='{year:04}-{month:02}-{day:02} {hour:02}:{minute:02} UTC'>{text}</time>"
    )
}

/// Gregorian civil date in UTC, independent of locale and host timezone.
fn civil(seconds: u64) -> (i64, i64, i64, u64, u64, u64) {
    let days = (seconds / 86400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (
        year,
        month,
        day,
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60,
    )
}

pub(super) const STYLES: &str = r#":root{color-scheme:light;--ground:#f4f5f2;--paper:#fff;--ink:#202d2c;--muted:#566463;--line:#dbe2de;--line-strong:#97a9a3;--teal:#205e58;--teal-ink:#174a44;--teal-soft:#e7f1ed;--orange:#ce7849;--orange-ink:#8a4519;--orange-soft:#fcf1e8;--orange-line:#efcfb7;--purple:#7861ad;--danger:#a52e27;--danger-soft:#fdf0ed;--danger-line:#e3bab4;--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font:16px/1.5 var(--sans);-webkit-text-size-adjust:100%;text-size-adjust:100%}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--ground);color:var(--ink);caret-color:var(--teal)}
::selection{background:#cde3da;color:var(--ink)}
h1,h2,p,figure,ul,ol{margin:0}
h1{font-size:1.75rem;line-height:1.2;letter-spacing:-.025em;font-weight:720;text-wrap:balance;overflow-wrap:anywhere}
h2{font-size:1.125rem;line-height:1.3;letter-spacing:-.01em;font-weight:680;overflow-wrap:anywhere}
a{color:var(--teal);text-decoration-thickness:1px;text-underline-offset:.2em}
a:hover{color:var(--teal-ink)}
code,pre,.origin,.origin-chip,.key,.address{font-family:var(--mono);font-variant-ligatures:none}
code{font-size:.9em}
time{font-variant-numeric:tabular-nums}
:focus-visible{outline:3px solid var(--purple);outline-offset:2px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.bar{background:var(--paper);border-bottom:1px solid var(--line)}
.bar-inner{max-width:46rem;margin:0 auto;padding:.6rem 1rem;display:flex;align-items:center;gap:.5rem 1.25rem;flex-wrap:wrap}
.brand{display:flex;align-items:center;min-height:2.75rem;margin-right:auto;color:var(--ink);font-weight:720;letter-spacing:-.02em;text-decoration:none}
.brand:hover{color:var(--ink)}
.brand-mark{width:.6rem;height:.6rem;margin-right:2.35rem;border-radius:50%;background:var(--orange);box-shadow:.85rem 0 var(--teal),1.7rem 0 var(--purple)}
.bar nav{display:flex;gap:.25rem}
.bar nav a{display:flex;align-items:center;min-height:2.75rem;padding:0 .7rem;color:var(--muted);font-weight:600;font-size:.9375rem;text-decoration:none;border-radius:.4rem}
.bar nav a:hover{color:var(--ink);background:var(--ground)}
.bar nav a[aria-current=page]{color:var(--ink);border-radius:0;box-shadow:inset 0 -2px var(--teal)}
.page{flex:1;width:100%;max-width:46rem;margin:0 auto;padding:2rem 1rem 3.5rem}
.page--compact{max-width:28rem;padding-top:clamp(2rem,9vh,4.5rem)}
.page--medium{max-width:38rem;padding-top:clamp(2rem,7vh,3.5rem)}
.panel{padding:1.75rem;background:var(--paper);border:1px solid var(--line);border-radius:.9rem;box-shadow:0 1px 2px #202d2c0d,0 12px 32px -18px #202d2c33}
.lede{margin-top:.5rem;color:var(--muted)}
.panel>p+p{margin-top:.75rem}
.hint{margin-top:.35rem;color:var(--muted);font-size:.875rem}
.hint.below{margin-top:.75rem}
.meta{margin-top:.15rem;color:var(--muted);font-size:.875rem}
.field{display:grid;gap:.4rem;margin-top:1.25rem}
label,legend{font-weight:620}
input:not([type=radio]){width:100%;min-height:3rem;padding:.65rem .8rem;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line-strong);border-radius:.5rem;transition:border-color .15s ease-out}
input:not([type=radio]):hover{border-color:var(--muted)}
.code-input{max-width:11rem;font-family:var(--mono);font-size:1.25rem;letter-spacing:.3em;font-variant-numeric:tabular-nums}
button,.button{display:inline-flex;align-items:center;justify-content:center;text-align:center;gap:.5rem;min-height:2.75rem;padding:.6rem 1.15rem;font:inherit;font-weight:650;line-height:1.2;color:#fff;background:var(--teal);border:1px solid transparent;border-radius:.5rem;text-decoration:none;cursor:pointer;transition:background-color .15s ease-out,border-color .15s ease-out,color .15s ease-out}
button:hover,.button:hover{color:#fff;background:var(--teal-ink)}
button:active,.button:active{transform:translateY(1px)}
.secondary,.secondary:hover{color:var(--ink)}
.secondary{background:var(--paper);border-color:var(--line-strong)}
.secondary:hover{background:var(--ground)}
.quiet{min-height:2.25rem;padding:.35rem .65rem;color:var(--muted);background:transparent;font-size:.9375rem}
.quiet:hover{color:var(--ink);background:var(--ground)}
.danger,.danger:hover{color:var(--danger)}
.secondary.danger{border-color:var(--danger-line)}
.danger:hover{background:var(--danger-soft)}
button:disabled,button:disabled:hover,.secondary.danger:disabled{color:var(--muted);background:var(--paper);border-color:var(--line);cursor:not-allowed;transform:none}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;margin-top:1.5rem}
.actions--end{flex-direction:row-reverse;justify-content:flex-start}
.wide{width:100%}
.sign-out{display:flex}
.alert{display:grid;gap:.2rem;margin-bottom:1.25rem;padding:.9rem 1.1rem;color:#7d2f22;background:#fff3ef;border:1px solid var(--danger-line);border-radius:.65rem}
.icon{flex:none;width:1.5rem;height:1.5rem;color:var(--orange-ink)}
.icon--on{color:var(--teal)}
.setup{display:flex;align-items:center;gap:.6rem;margin-bottom:1rem;padding:.6rem 0 .75rem;font-size:.9375rem;color:var(--muted);border-bottom:1px solid var(--line)}
.setup .icon{width:1.25rem;height:1.25rem}
.setup span{flex:1}
.setup a{font-weight:650;white-space:nowrap}
.dot{flex:none;width:.6rem;height:.6rem;border-radius:50%;background:var(--line-strong)}
.request{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:.25rem 1rem;margin-bottom:1rem;padding:1.15rem 1.25rem;background:var(--orange-soft);border:1px solid var(--orange-line);border-radius:.9rem}
.request .dot{align-self:start;margin-top:.55rem;background:var(--orange)}
.request h2{font-size:1.25rem}
.request h2 span{font-weight:500;color:var(--muted)}
.request-origin{margin-top:.2rem;font-size:.9375rem;overflow-wrap:anywhere}
.request .meta{color:#6b5546}
.feed+.feed,.request+.feed,.setup+.feed,.alert+.feed{margin-top:1.75rem}
.day{padding-bottom:.5rem;color:var(--muted);font-size:.8125rem;font-weight:650;border-bottom:1px solid var(--line)}
.events{list-style:none;padding:0}
.event{display:grid;grid-template-columns:3rem .6rem 1fr auto;align-items:start;gap:0 .9rem;padding:.95rem 0;border-bottom:1px solid var(--line)}
.when{padding-top:.1rem;color:var(--muted);font-size:.8125rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.when time{text-decoration:none}
.event .dot{margin-top:.5rem}
.event--active .dot,.event--live .dot{background:var(--teal)}
.event--live .dot{animation:breathe 2.6s cubic-bezier(.16,1,.3,1) infinite}
.event--paused .dot{background:var(--orange)}
.event--ended .dot,.event--past .dot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--line-strong)}
.event-main{min-width:0}
.event-line{font-weight:560;overflow-wrap:anywhere}
.event-line .verb{font-weight:500;color:var(--muted)}
.event--ended .event-line,.event--past .event-line{color:var(--muted)}
.event-action{margin-top:-.2rem}
.sign-in-security{margin:1.75rem 0}
.sign-in-security .meta{overflow-wrap:anywhere}
.sign-in-pauses{list-style:none;padding:0;margin:.75rem 0}
.sign-in-pause{padding:.75rem 1rem;background:var(--orange-soft);border:1px solid var(--orange-line);border-radius:.6rem}
.sign-in-pause+.sign-in-pause{margin-top:.5rem}
.origin .scheme{color:var(--muted);font-weight:400}
.origin{font-size:.9375em}
.track{max-width:14rem;height:3px;margin-top:.6rem;overflow:hidden;background:var(--line);border-radius:2px}
.track i{display:block;height:100%;background:var(--teal);transform-origin:left;transform:scaleX(var(--from,1));animation:drain linear forwards}
@keyframes drain{from{transform:scaleX(var(--from,1))}to{transform:scaleX(0)}}
@keyframes breathe{0%{box-shadow:0 0 0 0 #205e5866}80%,100%{box-shadow:0 0 0 .55rem #205e5800}}
summary{width:fit-content;list-style:none;cursor:pointer}
summary::-webkit-details-marker{display:none}
summary::before{content:"";display:inline-block;flex:none;width:.42rem;height:.42rem;margin:0 .55rem .12em .1rem;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .15s ease-out}
details[open]>summary::before{transform:rotate(45deg)}
.tools{margin-top:.4rem}
.tools>summary,.manual>summary,.fineprint summary{display:flex;align-items:center;min-height:2rem;color:var(--teal);font-size:.875rem;font-weight:600}
.tools[open]>.tool-list{margin-top:.4rem}
.tool-list{list-style:none;padding:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.tool-list li+li{border-top:1px solid var(--line)}
.tool-list summary{display:flex;align-items:baseline;width:100%;padding:.75rem .9rem;color:var(--muted)}
.tool-text{display:grid;gap:.1rem;min-width:0}
.tool-text code{color:var(--ink);font-weight:650;overflow-wrap:anywhere}
.tool-text span{color:var(--muted);font-size:.9375rem;overflow-wrap:anywhere}
pre{max-height:22rem;margin:0 .9rem .9rem;padding:.8rem .9rem;overflow:auto;font-size:.8125rem;line-height:1.55;tab-size:2;background:var(--ground);border-radius:.45rem}
.first-run h1{font-size:1.5rem}
.addresses{list-style:none;padding:0;margin-top:1rem;border-top:1px solid var(--line)}
.addresses li{display:flex;align-items:center;justify-content:space-between;gap:.5rem 1rem;padding:.6rem 0;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.copy{display:flex;align-items:center;gap:.5rem}
.copy .copy-status{margin:0;padding:0}
.copy button{color:var(--teal);font-weight:650}
.copy button:hover{color:var(--teal-ink);background:var(--teal-soft)}
.address{font-size:.9375rem;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
.section{margin-top:2.25rem}
.list{margin-top:1.25rem;border-top:1px solid var(--line)}
.addresses+.list,.section:has(>.addresses)+.list{margin-top:0;border-top:0}
.list .row{padding:1rem 0;border-bottom:1px solid var(--line)}
.hint code,.alert code{white-space:nowrap}
.section>h2{margin-bottom:.75rem}
.row{display:flex;align-items:center;gap:.9rem;padding:1rem 1.15rem}
.row-main{flex:1;min-width:0}
.row>.icon{align-self:flex-start;margin-top:.1rem}
.row-title{font-weight:620}
.enroll{display:grid;grid-template-columns:auto 1fr;align-items:start;gap:1.25rem 1.75rem;margin-top:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--line)}
.qr{display:grid;justify-items:center;gap:.5rem;width:12rem}
.qr svg{display:block;width:12rem;height:12rem;padding:.35rem;background:#fff;border:1px solid var(--line);border-radius:.6rem}
.enroll-other{display:grid;gap:.75rem;align-content:start;padding-top:.25rem}
.open-app{order:2;display:flex;align-items:center;min-height:2rem;font-size:.875rem;font-weight:600}
.copy-status{margin-left:auto;padding-left:.5rem;font-size:.75rem;font-weight:500}
.copy-status.copied{animation:copy-feedback .8s ease-out}
@keyframes copy-feedback{from{opacity:.25}to{opacity:1}}
.key{display:flex;flex-wrap:wrap;gap:.15rem .65rem;margin-top:.5rem;padding:.65rem .8rem;font-size:1rem;letter-spacing:.06em;background:var(--ground);border-radius:.45rem;user-select:all;-webkit-user-select:all}
.consent-head{padding-bottom:1.25rem;border-bottom:1px solid var(--line)}
.consent-head h1{font-size:2rem}
.from{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;margin-top:.85rem;color:var(--muted);font-size:1.125rem}
.consent-head .app{overflow-wrap:anywhere}
.origin-chip{padding:.3rem .6rem;font-size:1.1875rem;font-weight:600;color:var(--ink);background:var(--paper);border:1px solid var(--line-strong);border-radius:.45rem;overflow-wrap:anywhere}
.block{margin-top:1.75rem}
.block h2{margin-bottom:.6rem}
fieldset{min-width:0;margin:1.75rem 0 0;padding:0;border:0}
legend{margin-bottom:.6rem;padding:0;font-size:1.125rem;font-weight:680;letter-spacing:-.01em}
.opts{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;overflow:hidden;background:var(--line-strong);border:1px solid var(--line-strong);border-radius:.55rem}
.opts label{position:relative;display:flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 .5rem;font-weight:600;background:var(--paper);cursor:pointer;transition:background-color .15s ease-out,color .15s ease-out}
.opts label:hover{background:var(--ground)}
.opts input,.option input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.opts label:has(:checked){color:#fff;background:var(--teal)}
.opts label:has(:focus-visible){outline:3px solid var(--purple);outline-offset:-3px;z-index:1}
.options{display:grid;gap:.5rem}
.option{position:relative;display:grid;grid-template-columns:auto 1fr;gap:.8rem;align-items:start;padding:.85rem 1rem;font-weight:400;background:var(--paper);border:1px solid var(--line-strong);border-radius:.65rem;cursor:pointer;transition:border-color .15s ease-out,background-color .15s ease-out}
.option:hover{border-color:var(--muted)}
.option>span:last-child{display:grid;gap:.1rem}
.option .meta{margin:0}
.radio{width:1.1rem;height:1.1rem;margin-top:.15rem;border:1.5px solid var(--line-strong);border-radius:50%;background:var(--paper);transition:border-color .15s ease-out,box-shadow .15s ease-out}
.option:has(:checked){background:var(--teal-soft);border-color:var(--teal);box-shadow:inset 0 0 0 1px var(--teal)}
.option:has(:checked) .radio{border-color:var(--teal);box-shadow:inset 0 0 0 .28rem var(--teal)}
.option:has(:focus-visible){outline:3px solid var(--purple);outline-offset:2px}
.fineprint{margin-top:1.75rem;padding-top:1.25rem;font-size:.875rem;color:var(--muted);border-top:1px solid var(--line)}
.fineprint details{margin-top:.4rem}
.fineprint details p,.limits p{margin-top:.6rem;max-width:65ch}
.limits{margin-top:.75rem;padding-top:0;border-top:0}
.decide{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:1rem 1.5rem;margin-top:1.75rem}
.decide:has(.field){padding:1.1rem 1.25rem;background:var(--paper);border:1px solid var(--line);border-radius:.85rem}
.decide .field{margin:0}
.decide-actions{display:flex;flex-direction:row-reverse;gap:.75rem;margin-left:auto}
.decide-actions button{min-width:7.5rem}
@media (prefers-reduced-motion:reduce){*,::before{transition:none!important}.event--live .dot,.track i,.copy-status.copied{animation:none}}
@media (max-width:600px){
h1{font-size:1.5rem}
.consent-head h1{font-size:1.625rem}
.bar-inner{padding:.35rem 1rem 0;gap:0 1rem}
.bar nav{order:3;width:100%;margin:0 -.7rem}
.page{padding-top:1.5rem}
.panel{padding:1.25rem}
.setup{flex-wrap:wrap;row-gap:0}
.setup span{flex:1 1 calc(100% - 2rem)}
.origin-chip{font-size:1.0625rem}
.setup a{display:flex;align-items:center;min-height:2.75rem;padding-left:1.85rem}
.open-app{order:0;justify-content:center;min-height:2.75rem;padding:.6rem 1.15rem;font-size:1rem;font-weight:650;color:var(--ink);text-decoration:none;background:var(--paper);border:1px solid var(--line-strong);border-radius:.5rem}
.open-app:hover{color:var(--ink);background:var(--ground)}
.request{grid-template-columns:auto 1fr;padding:1rem}
.request .button{grid-column:1/-1;width:100%;margin-top:.6rem}
.event{grid-template-columns:2.25rem .6rem 1fr}
.event-action{grid-column:3;margin-top:.35rem}
.quiet{min-height:2.75rem;padding-inline:0}
summary,.tools>summary,.manual>summary,.fineprint summary{min-height:2.75rem}
.row{flex-wrap:wrap}
.row form,.row .button,.row form button{width:100%}
.actions .button,.actions button{width:100%}
.enroll{grid-template-columns:1fr}
.enroll-other{order:-1}
.qr{justify-self:center}
.opts{grid-template-columns:repeat(2,1fr)}
.decide:has(.field){padding:1rem}
.decide .field,.decide-actions{width:100%}
.decide-actions{flex-direction:column}
.decide-actions button{width:100%}
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_security_preserves_empty_app_heading_and_escapes_history() {
        let page = console(Console {
            now: 1_700_000_000,
            logout_token: "fixture".into(),
            problems: vec![],
            requests: vec![],
            live: Some(vec![]),
            events: vec![],
            addresses: vec![
                "https://gateway.example".into(),
                "https://other.example".into(),
            ],
            sign_in_failures: vec![
                SignInFailure {
                    at: 1_699_999_940,
                    reason: "<script>failure</script>",
                    entry_point: Some("https://gateway.example/<img src=x>".into()),
                },
                SignInFailure {
                    at: 1_699_999_930,
                    reason: "The sign-in request could not be verified.",
                    entry_point: None,
                },
            ],
            sign_in_pauses: vec![],
        });
        assert_eq!(page.body.matches("<h1").count(), 1);
        assert!(page.body.contains("No apps yet"));
        assert!(
            page.body.find("Sign-in failures").unwrap() < page.body.find("No apps yet").unwrap()
        );
        assert!(page.body.contains("&lt;script&gt;failure&lt;/script&gt;"));
        assert!(page.body.contains("gateway.example/&lt;img src=x&gt;"));
        assert!(!page.body.contains("Gateway address"));
        assert!(!page.body.contains("<script>failure"));
        assert!(page.body.contains("datetime='2023-11-14T22:12:20Z'"));
        assert!(!page.body.contains("last 24 hours"));
    }

    #[test]
    fn sign_in_security_limits_history_to_latest_twenty() {
        let failures: Vec<_> = (0..64)
            .map(|index| SignInFailure {
                at: 1_700_000_000 - index,
                reason: "Wrong passphrase.",
                entry_point: Some(format!("https://gateway-{index}.example")),
            })
            .collect();
        let body = sign_in_security(1_700_000_000, &failures, &[], true);
        assert_eq!(body.matches("class='event sign-in-failure'").count(), 20);
        assert!(body.contains("gateway-0.example"));
        assert!(body.contains("gateway-19.example"));
        assert!(!body.contains("gateway-20.example"));
        assert!(!body.contains("gateway-63.example"));
        assert!(sign_in_security(1_700_000_000, &[], &[], true).is_empty());
        // One address: the rows don't repeat it.
        let single = sign_in_security(1_700_000_000, &failures, &[], false);
        assert!(!single.contains("gateway-0.example"));
    }

    #[test]
    fn sign_in_security_pauses_say_what_is_paused_and_when_it_resumes() {
        let pauses = [
            SignInPause {
                label: "Sign-in paused",
                until: 1_700_000_900,
            },
            SignInPause {
                label: "Passkey and code attempts paused",
                until: 1_700_000_060,
            },
            SignInPause {
                label: "New connections paused",
                until: 1_700_000_030,
            },
            SignInPause {
                label: "Expired pause",
                until: 1_700_000_000,
            },
        ];
        let body = sign_in_security(1_700_000_000, &[], &pauses, false);
        assert!(body.contains("Sign-in paused · try again <time"));
        assert!(body.contains("Passkey and code attempts paused · try again <time"));
        assert!(body.contains("New connections paused · try again <time"));
        assert!(body.contains(">in 15 min</time>"));
        assert!(body.contains("datetime='2023-11-14T22:28:20Z'"));
        assert!(!body.contains("Expired pause"));
        assert!(sign_in_security(1_700_000_000, &[], &pauses[3..], false).is_empty());
    }

    #[test]
    fn civil_time_and_spans() {
        assert_eq!(civil(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil(1_700_000_000), (2023, 11, 14, 22, 13, 20));
        assert_eq!(civil(951_782_400), (2000, 2, 29, 0, 0, 0));
        assert_eq!(span(0), "under a minute");
        assert_eq!(span(60), "1 min");
        assert_eq!(span(3600), "1 h");
        assert_eq!(span(86_400), "1 day");
        assert_eq!(span(2_592_000), "30 days");
    }
}
