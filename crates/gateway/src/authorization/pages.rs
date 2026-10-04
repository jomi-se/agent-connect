//! Owner-facing HTML. Rendering only: callers decide authority, mint CSRF tokens
//! and pass plain data; everything interpolated here is escaped here.

use super::{AUTHORIZE, LOGIN, OWNER, Tool, escape, hidden};
use std::fmt::Write as _;

pub(super) const SECURITY: &str = "/agent-connect/owner/security";
pub(super) const GATEWAY: &str = "/agent-connect/owner/gateway";
pub(super) const TOTP: &str = "/agent-connect/owner/totp";

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
        "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='color-scheme' content='light'><title>{} · Agent Connect</title><style>{STYLES}</style>{dynamic}</head><body><header class='bar'><div class='bar-inner'><a class='brand' href='{OWNER}'><span class='brand-mark' aria-hidden='true'></span>Agent Connect</a>{nav}</div></header><main class='{width}'>{}</main><footer class='foot'>Served by your own Agent Connect gateway.</footer>{script}</body></html>",
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

pub(super) fn sign_in(fields: &str, factor: bool, waiting: Option<&str>) -> Page {
    let lede = match waiting {
        Some(name) => format!(
            "Sign in to review the request from <strong>{}</strong>.",
            escape(name)
        ),
        None => "Manage the apps that use your agent.".into(),
    };
    let factor = if factor {
        format!(
            "<div class='field'><label for='login-totp'>Authenticator code</label><input id='login-totp' name=totp {CODE_INPUT} required></div>"
        )
    } else {
        String::new()
    };
    plain(
        "Sign in",
        Width::Compact,
        format!(
            "<div class='panel'><h1>Sign in</h1><p class='lede'>{lede}</p><form method=post action='{LOGIN}'>{fields}<div class='field'><label for='owner-passphrase'>Owner passphrase</label><input id='owner-passphrase' type=password name=passphrase autocomplete=current-password required maxlength=1024></div>{factor}<div class='actions'><button class='wide'>Sign in</button></div></form></div>"
        ),
    )
}

pub(super) struct Console {
    pub now: u64,
    pub logout_token: String,
    pub problems: Vec<(String, String)>,
    pub authenticator: bool,
    pub requests: Vec<Request>,
    /// None when the session runtime cannot report.
    pub live: Option<Vec<Live>>,
    pub events: Vec<Event>,
    pub addresses: Vec<String>,
}

pub(super) struct Request {
    pub name: String,
    pub origin: String,
    pub href: String,
    pub tools: usize,
    pub expires: u64,
}

pub(super) struct Live {
    pub origin: String,
    pub id: String,
    pub state: String,
    pub started: u64,
    pub end_token: String,
}

pub(super) struct Event {
    pub at: Option<u64>,
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
            escape(repair)
        );
    }
    if !view.authenticator {
        let _ = write!(
            body,
            "<div class='setup'>{}<p><strong>Add an authenticator.</strong> Right now your passphrase alone can approve apps.</p><a class='button' href='{TOTP}'>Set up</a></div>",
            shield(false)
        );
    }
    for (index, request) in view.requests.iter().enumerate() {
        let _ = write!(
            body,
            "<article class='request' aria-labelledby='request-{0}'><span class='dot' aria-hidden='true'></span><div><h2 id='request-{0}'>{1} <span>wants to use your agent</span></h2><p class='request-origin'>{2}</p><p class='meta'>{3} tool{4} · request expires {5}</p></div><a class='button' href='{6}'>Review</a></article>",
            index,
            escape(&request.name),
            origin(&request.origin),
            request.tools,
            if request.tools == 1 { "" } else { "s" },
            until(now, request.expires),
            escape(&request.href)
        );
    }
    let live = view.live.as_deref().unwrap_or_default();
    if view.live.is_none() {
        body.push_str("<div class='alert' role='status'><strong>Session status is unavailable.</strong><p>Check the gateway before relying on session controls.</p></div>");
    }
    if view.requests.is_empty() && live.is_empty() && view.events.is_empty() {
        let _ = write!(
            body,
            "<section class='empty' aria-labelledby='empty-title'><h1 id='empty-title'>No apps yet</h1><p>To connect an app, give it this gateway’s address:</p>{}<p class='hint'>Its request will appear here for you to approve.</p></section>",
            addresses(&view.addresses)
        );
        return owner_page(
            "Activity",
            Tab::Activity,
            view.logout_token,
            body,
            String::new(),
        );
    }
    body.push_str("<h1 class='visually-hidden'>Activity</h1>");
    let mut css = String::new();
    if !live.is_empty() {
        body.push_str("<section class='feed' aria-labelledby='feed-now'><h2 class='day' id='feed-now'>Now</h2><ol class='events'>");
        for session in live {
            let short = session.id.get(..8).unwrap_or(&session.id);
            let _ = write!(
                body,
                "<li class='event event--live'><span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'>{} <span class='verb'>is connected</span></p><p class='meta'>Session {} · {} · started {}</p></div><form class='event-action' method=post action='/agent-connect/owner/sessions/end'>{}{}<button class='quiet danger'>End session</button></form></li>",
                origin(&session.origin),
                escape(short),
                escape(&session.state),
                ago(now, session.started),
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

fn event_row(now: u64, index: usize, event: &Event, css: &mut String) -> String {
    let when = event
        .at
        .map(|at| ago(now, at))
        .unwrap_or_else(|| "Earlier".into());
    match &event.kind {
        EventKind::Revoked => format!(
            "<li class='event event--ended'><span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'><span class='verb'>Revoked</span> {}</p><p class='meta'>{when}</p></div></li>",
            origin(&event.origin)
        ),
        EventKind::Expired => format!(
            "<li class='event event--ended'><span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'><span class='verb'>Access ended for</span> {}</p><p class='meta'>{when} · expired</p></div></li>",
            origin(&event.origin)
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
                        format!("ends {}", until(now, *expires)),
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
                    "paused: the gateway’s profile settings changed".into(),
                    "",
                    String::new(),
                ),
                GrantState::Ended => (
                    "event--past",
                    lifetime
                        .map(|total| format!("for {}", span(total)))
                        .unwrap_or_default(),
                    "",
                    String::new(),
                ),
            };
            let status = if status.is_empty() {
                String::new()
            } else {
                format!(" · {status}")
            };
            format!(
                "<li class='event {class}' id='grant-{index}'><span class='dot' aria-hidden='true'></span><div class='event-main'><p class='event-line'><span class='verb'>Approved</span> {}</p><p class='meta'>{when} · {} · {count}{status}</p>{track}<details class='tools'><summary>Show {count}</summary>{}</details></div>{action}</li>",
                origin(&event.origin),
                escape(profile),
                tool_list(tools)
            )
        }
    }
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
    pub authenticator: bool,
    pub active_grants: usize,
    pub revoke_all_token: String,
}

pub(super) fn security(view: Security) -> Page {
    let authenticator = if view.authenticator {
        format!(
            "<div class='row'>{}<div class='row-main'><p class='row-title'>Authenticator is on</p><p class='meta'>Sign-in and every approval need a fresh code.</p></div></div><p class='hint below'>Lost it? On the gateway host, stop the gateway and run <code>agent-connect reset-totp</code>, then set it up again here. App access is not affected.</p>",
            shield(true)
        )
    } else {
        format!(
            "<div class='row'>{}<div class='row-main'><p class='row-title'>Authenticator is off</p><p class='meta'>Your passphrase alone can sign in and approve apps.</p></div><a class='button' href='{TOTP}'>Set up</a></div>",
            shield(false)
        )
    };
    let apps = view.active_grants;
    let body = format!(
        "<h1>Security</h1><section class='section' aria-labelledby='authenticator-title'><h2 id='authenticator-title'>Authenticator</h2><div class='rows'>{authenticator}</div></section><section class='section' aria-labelledby='access-title'><h2 id='access-title'>App access</h2><div class='rows'><div class='row'><div class='row-main'><p class='row-title'>Revoke access for every app</p><p class='meta'>{}. Revoking can’t undo what they already did.</p></div><form method=post action='/agent-connect/owner/grants/revoke-all'>{}<button class='secondary danger'{}>Revoke all</button></form></div></div></section>",
        match apps {
            0 => "No app has access right now".to_string(),
            1 => "1 app has access".to_string(),
            n => format!("{n} apps have access"),
        },
        hidden("csrf_token", &view.revoke_all_token),
        if apps == 0 { " disabled" } else { "" }
    );
    owner_page(
        "Security",
        Tab::Security,
        view.logout_token,
        body,
        String::new(),
    )
}

pub(super) struct Gateway {
    pub logout_token: String,
    pub harness: &'static str,
    pub addresses: Vec<String>,
    pub profiles: Vec<(&'static str, &'static str)>,
    pub profile_note: &'static str,
}

pub(super) fn gateway(view: Gateway) -> Page {
    let profiles = view
        .profiles
        .iter()
        .map(|(label, description)| {
            format!(
                "<div class='row'><div class='row-main'><p class='row-title'>{}</p><p class='meta'>{}</p></div></div>",
                escape(label),
                escape(description)
            )
        })
        .collect::<String>();
    let body = format!(
        "<h1>Gateway</h1><section class='section' aria-labelledby='addresses-title'><h2 id='addresses-title'>Addresses</h2><p class='section-lede'>Give an app one of these addresses. You sign in and approve on the address the app uses.</p>{}</section><section class='section' aria-labelledby='agent-title'><h2 id='agent-title'>Agent</h2><div class='rows'><div class='row'><div class='row-main'><p class='row-title'>{}</p><p class='meta'>Runs each session in a disposable box with restricted network access.</p></div></div></div></section><section class='section' aria-labelledby='profiles-title'><h2 id='profiles-title'>Native access profiles</h2><p class='section-lede'>You pick one each time you approve an app. It limits what the agent’s own tools may do; app tools follow the approval.</p><div class='rows'>{profiles}</div><p class='hint below'>{}</p></section>",
        addresses(&view.addresses),
        escape(view.harness),
        escape(view.profile_note)
    );
    owner_page(
        "Gateway",
        Tab::Gateway,
        view.logout_token,
        body,
        String::new(),
    )
}

fn addresses(list: &[String]) -> String {
    let rows = list
        .iter()
        .map(|address| {
            format!(
                "<li><code class='address'>{}</code><a href='{}{OWNER}'>Open</a></li>",
                escape(address),
                escape(address)
            )
        })
        .collect::<String>();
    format!("<ul class='addresses'>{rows}</ul>")
}

pub(super) fn totp_start(fields: &str) -> Page {
    plain(
        "Set up an authenticator",
        Width::Compact,
        format!(
            "<div class='panel'><h1>Set up an authenticator</h1><p class='lede'>Sign-in and every approval will also need a six-digit code from an authenticator app. First, confirm it’s you.</p><form method=post action='/agent-connect/owner/totp/enroll'>{fields}<div class='field'><label for='enroll-passphrase'>Owner passphrase</label><input id='enroll-passphrase' type=password name=passphrase autocomplete=current-password required maxlength=1024></div><div class='actions actions--end'><button>Continue</button><a class='button secondary' href='{SECURITY}'>Cancel</a></div></form></div>"
        ),
    )
}

pub(super) fn totp_scan(secret: &str, uri: &str, fields: &str) -> Page {
    let key = secret
        .as_bytes()
        .chunks(4)
        .map(|chunk| format!("<span>{}</span>", escape(&String::from_utf8_lossy(chunk))))
        .collect::<String>();
    let mut page = plain(
        "Add to your authenticator",
        Width::Medium,
        format!(
            "<div class='panel'><h1>Add Agent Connect to your authenticator</h1><p class='lede'>Scan the code, or open it directly on this phone. This setup expires in 10 minutes.</p><div class='enroll'><figure class='qr'>{}<figcaption>Scan with your authenticator app</figcaption></figure><div class='enroll-other'><a class='button secondary' href='{}'>Open in authenticator app</a><details class='manual'><summary>Enter the key by hand<span class='copy-status' role='status' aria-live='polite'></span></summary><p class='key' aria-label='Setup key'>{key}</p><p class='hint'>Time-based · 6 digits · 30 seconds</p></details></div></div><form method=post action='/agent-connect/owner/totp/verify'>{fields}<div class='field'><label for='enrollment-totp'>Code shown in your authenticator</label><input id='enrollment-totp' name=totp {CODE_INPUT} required></div><div class='actions actions--end'><button>Turn on</button><a class='button secondary' href='{SECURITY}'>Cancel</a></div></form><p class='hint below'>If you lose the authenticator, recovery needs a command on the gateway host.</p></div>",
            qr(uri),
            escape(uri)
        ),
    );
    page.script = COPY_KEY_SCRIPT;
    page
}

const COPY_KEY_SCRIPT: &str = r#"(() => {
  const manual = document.querySelector('.manual');
  const status = manual.querySelector('.copy-status');
  let timer;
  manual.querySelector('summary').addEventListener('click', async () => {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(manual.querySelector('.key').textContent);
      status.textContent = 'Copied';
      status.classList.remove('copied');
      void status.offsetWidth;
      status.classList.add('copied');
    } catch {
      status.textContent = 'Copy unavailable';
    }
    timer = setTimeout(() => { status.textContent = ''; }, 3000);
  });
})();"#;

pub(super) struct Consent {
    pub name: String,
    pub origin: String,
    pub tools: Vec<Tool>,
    pub fields: String,
    pub profiles: Vec<ProfileChoice>,
    pub factor: bool,
}

pub(super) struct ProfileChoice {
    pub value: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
    pub detail: &'static str,
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
    let details = view
        .profiles
        .iter()
        .map(|profile| {
            format!(
                "<p><strong>{}.</strong> {}</p>",
                escape(profile.label),
                escape(profile.detail)
            )
        })
        .collect::<String>();
    let factor = if view.factor {
        format!(
            "<div class='field'><label for='approval-totp'>Authenticator code</label><input id='approval-totp' name=totp {CODE_INPUT} aria-describedby='approval-help'><p id='approval-help' class='hint'>Needed to approve, not to deny.</p></div>"
        )
    } else {
        String::new()
    };
    let count = view.tools.len();
    let mut page = plain(
        &format!("Allow {}?", view.name),
        Width::Full,
        format!(
            "<header class='consent-head'><h1>Allow <span class='app'>{}</span> to use your agent?</h1><p class='from'>Request from <span class='origin-chip'>{}</span></p></header><section class='block' aria-labelledby='tools-title'><h2 id='tools-title'>It can call {} tool{}</h2><p class='section-lede'>Only these, exactly as described. Open one to see its input schema.</p>{}</section><form class='decision' method=post action='{AUTHORIZE}'>{}<fieldset class='segmented'><legend>Access lasts</legend><div class='opts'>{durations}</div><p class='hint'>You can revoke it sooner from Activity.</p></fieldset><fieldset class='options'><legend>Your agent’s own tools</legend>{profiles}</fieldset><div class='fineprint'><p>An app you approve could obtain your agent’s login and read other apps’ conversations with it. Revoking stops future use; it can’t undo what’s already done.</p><details><summary>What this means</summary><p>Each session runs in a disposable box with restricted network access. The option you pick limits the agent’s own tools there; this app’s tools follow this approval.</p><p>All approved apps share one dedicated login for your agent.</p>{details}<p>Agent Connect uses ACP and MCP-over-ACP, which are still unstable protocols.</p></details></div><div class='decide'>{factor}<div class='decide-actions'><button name=decision value=approve>Approve</button><button class='secondary' name=decision value=deny>Deny</button></div></div></form>",
            escape(&view.name),
            escape(&view.origin),
            count,
            if count == 1 { "" } else { "s" },
            tool_list(&view.tools),
            view.fields
        ),
    );
    page.width = Width::Full;
    page
}

pub(super) fn error(title: &str, message: &str, target: &str, label: &str) -> Page {
    plain(
        title,
        Width::Compact,
        format!(
            "<div class='panel'><h1>{}</h1><p class='lede' role='alert'>{}</p><div class='actions'><a class='button wide' href='{target}'>{label}</a></div></div>",
            escape(title),
            escape(message)
        ),
    )
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

fn ago(now: u64, at: u64) -> String {
    let age = now.saturating_sub(at);
    let text = if age < 60 {
        "just now".into()
    } else {
        format!("{} ago", span(age))
    };
    stamp(at, &text)
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
.foot{padding:0 1rem 1.5rem;text-align:center;color:var(--muted);font-size:.8125rem}
.panel{padding:1.75rem;background:var(--paper);border:1px solid var(--line);border-radius:.9rem;box-shadow:0 1px 2px #202d2c0d,0 12px 32px -18px #202d2c33}
.lede{margin-top:.5rem;color:var(--muted)}
.hint{margin-top:.35rem;color:var(--muted);font-size:.875rem}
.hint.below{margin-top:.75rem}
.meta{margin-top:.15rem;color:var(--muted);font-size:.875rem}
.section-lede{margin:-.35rem 0 .75rem;color:var(--muted);font-size:.9375rem}
.field{display:grid;gap:.4rem;margin-top:1.25rem}
label,legend{font-weight:620}
input:not([type=radio]){width:100%;min-height:3rem;padding:.65rem .8rem;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line-strong);border-radius:.5rem;transition:border-color .15s ease-out}
input:not([type=radio]):hover{border-color:var(--muted)}
.code-input{max-width:11rem;font-family:var(--mono);font-size:1.25rem;letter-spacing:.3em;font-variant-numeric:tabular-nums}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.75rem;padding:.6rem 1.15rem;font:inherit;font-weight:650;line-height:1.2;color:#fff;background:var(--teal);border:1px solid transparent;border-radius:.5rem;text-decoration:none;cursor:pointer;transition:background-color .15s ease-out,border-color .15s ease-out,color .15s ease-out}
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
button:disabled,button:disabled:hover{color:var(--muted);background:var(--paper);border-color:var(--line);cursor:not-allowed;transform:none}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;margin-top:1.5rem}
.actions--end{flex-direction:row-reverse;justify-content:flex-start}
.wide{width:100%}
.sign-out{display:flex}
.alert{display:grid;gap:.2rem;margin-bottom:1.25rem;padding:.9rem 1.1rem;color:#7d2f22;background:#fff3ef;border:1px solid var(--danger-line);border-radius:.65rem}
.icon{flex:none;width:1.5rem;height:1.5rem;color:var(--orange-ink)}
.icon--on{color:var(--teal)}
.setup{display:flex;align-items:center;gap:.9rem;margin-bottom:1.5rem;padding:.9rem 1rem .9rem 1.1rem;background:var(--paper);border:1px solid var(--line);border-radius:.75rem}
.setup p{flex:1}
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
.event{display:grid;grid-template-columns:.6rem 1fr auto;align-items:start;gap:0 .9rem;padding:.95rem 0;border-bottom:1px solid var(--line)}
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
.tool-list{list-style:none;padding:0;background:var(--paper);border:1px solid var(--line);border-radius:.65rem}
.tool-list li+li{border-top:1px solid var(--line)}
.tool-list summary{display:flex;align-items:baseline;width:100%;padding:.75rem .9rem;color:var(--muted)}
.tool-text{display:grid;gap:.1rem;min-width:0}
.tool-text code{color:var(--ink);font-weight:650;overflow-wrap:anywhere}
.tool-text span{color:var(--muted);font-size:.9375rem;overflow-wrap:anywhere}
pre{max-height:22rem;margin:0 .9rem .9rem;padding:.8rem .9rem;overflow:auto;font-size:.8125rem;line-height:1.55;tab-size:2;background:var(--ground);border-radius:.45rem}
.empty{padding:2rem 1.5rem;background:var(--paper);border:1px dashed var(--line-strong);border-radius:.9rem}
.empty h1{font-size:1.5rem}
.empty>p{margin-top:.6rem}
.addresses{list-style:none;padding:0;margin-top:.75rem;background:var(--paper);border:1px solid var(--line);border-radius:.65rem}
.addresses li{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.7rem .9rem;flex-wrap:wrap}
.addresses li+li{border-top:1px solid var(--line)}
.address{font-size:.9375rem;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
.addresses a{display:flex;align-items:center;min-height:2rem;font-size:.875rem;font-weight:600}
.empty .addresses{background:var(--ground);border-color:transparent}
.section{margin-top:2.25rem}
h1+.section{margin-top:1.5rem}
.section>h2{margin-bottom:.75rem}
.rows{background:var(--paper);border:1px solid var(--line);border-radius:.75rem}
.row{display:flex;align-items:center;gap:.9rem;padding:1rem 1.15rem}
.row+.row{border-top:1px solid var(--line)}
.row-main{flex:1;min-width:0}
.row-title{font-weight:620}
.rows+.hint{padding:0 .25rem}
.enroll{display:grid;grid-template-columns:auto 1fr;align-items:start;gap:1.25rem 1.75rem;margin-top:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--line)}
.qr{display:grid;justify-items:center;gap:.5rem;width:12rem}
.qr svg{display:block;width:12rem;height:12rem;padding:.35rem;background:#fff;border:1px solid var(--line);border-radius:.6rem}
.qr figcaption{color:var(--muted);font-size:.8125rem;text-align:center}
.enroll-other{display:grid;gap:.75rem;align-content:start;padding-top:.25rem}
.copy-status{margin-left:auto;padding-left:.5rem;font-size:.75rem;font-weight:500}
.copy-status.copied{animation:copy-feedback .8s ease-out}
@keyframes copy-feedback{from{opacity:.25}to{opacity:1}}
.key{display:flex;flex-wrap:wrap;gap:.15rem .65rem;margin-top:.5rem;padding:.65rem .8rem;font-size:1rem;letter-spacing:.06em;background:var(--ground);border-radius:.45rem;user-select:all;-webkit-user-select:all}
.consent-head{padding-bottom:1.25rem;border-bottom:1px solid var(--line)}
.consent-head h1{font-size:2rem}
.from{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;margin-top:.85rem;color:var(--muted)}
.origin-chip{padding:.3rem .6rem;font-size:.9375rem;color:var(--ink);background:var(--paper);border:1px solid var(--line-strong);border-radius:.45rem;overflow-wrap:anywhere}
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
.fineprint details p{margin-top:.6rem;max-width:65ch}
.decide{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:1rem 1.5rem;margin-top:1.75rem;padding:1.1rem 1.25rem;background:var(--paper);border:1px solid var(--line);border-radius:.85rem}
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
.setup{flex-wrap:wrap}
.setup .button{width:100%}
.request{grid-template-columns:auto 1fr;padding:1rem}
.request .button{grid-column:1/-1;width:100%;margin-top:.6rem}
.event{grid-template-columns:.6rem 1fr}
.event-action{grid-column:2;margin-top:.35rem}
.quiet{min-height:2.75rem;padding-inline:0}
summary,.tools>summary,.manual>summary,.fineprint summary,.addresses a{min-height:2.75rem}
.row{flex-wrap:wrap}
.row form,.row .button,.row form button{width:100%}
.actions .button,.actions button{width:100%}
.enroll{grid-template-columns:1fr}
.enroll-other{order:-1}
.qr{justify-self:center}
.opts{grid-template-columns:repeat(2,1fr)}
.decide{padding:1rem}
.decide .field,.decide-actions{width:100%}
.decide-actions{flex-direction:column}
.decide-actions button{width:100%}
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

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
