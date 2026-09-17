import type {
  DelegatedGrantView,
  DelegatedNativeCapability,
} from "../delegated-grants.js";

const PAGE_STYLES = `
:root{color-scheme:light;--ground:oklch(.972 .006 250);--plate:oklch(1 0 0);--ink:oklch(.2 .018 250);--ink-raised:oklch(.27 .022 250);--muted:oklch(.46 .018 250);--line:oklch(.85 .012 250);--line-strong:oklch(.7 .018 250);--soft:oklch(.935 .01 250);--app:oklch(.56 .16 32.1);--app-soft:oklch(.94 .035 32.1);--app-ink:oklch(.37 .12 32.1);--connector:oklch(.43 .09 190);--connector-soft:oklch(.95 .025 190);--agent:oklch(.52 .15 275);--signal:oklch(.79 .14 83);--action:var(--ink);--action-hover:var(--ink-raised);--danger:oklch(.5 .18 25);--danger-soft:oklch(.96 .03 25);--success:oklch(.48 .12 150);--focus:var(--agent);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}html{scrollbar-color:var(--line-strong) var(--ground)}body{margin:0;background:var(--ground);color:var(--ink);min-height:100vh}body::selection{background:var(--connector-soft);color:var(--connector-ink,#174b4b)}button,input{font:inherit;accent-color:var(--connector);caret-color:var(--connector)}a{color:var(--connector);text-underline-offset:.18em}.page{min-height:100vh;display:grid;place-items:center;padding:clamp(1rem,4vw,3rem)}.stack{width:min(100%,32rem)}.stack--wide{width:min(100%,48rem)}.brand{display:flex;align-items:center;gap:.65rem;margin:0 0 1rem;color:var(--ink);font-weight:760;letter-spacing:-.025em}.brand-mark{display:inline-flex;align-items:center;gap:.19rem}.brand-mark span{width:.44rem;height:.44rem;border-radius:50%}.brand-mark span:nth-child(1){background:var(--app)}.brand-mark span:nth-child(2){background:var(--connector)}.brand-mark span:nth-child(3){background:var(--agent)}.plate{background:var(--plate);border-radius:.875rem;box-shadow:0 .5rem 1.8rem oklch(.2 .018 250/.1);overflow:hidden}.plate-head,.plate-body,.plate-foot{padding:clamp(1.25rem,4vw,2rem)}.plate-head{padding-bottom:1.2rem;border-bottom:1px solid var(--line)}.plate-body{padding-top:1.6rem}.plate-foot{padding-top:1rem;border-top:1px solid var(--line);background:var(--ground)}.context{display:flex;align-items:center;gap:.8rem;min-width:0}.app-avatar{display:grid;place-items:center;flex:0 0 auto;width:2.6rem;height:2.6rem;border-radius:.625rem;background:var(--app-soft);color:var(--app-ink);font-weight:800;text-transform:uppercase}.context-copy{min-width:0}.context-name{margin:0;font-weight:700;overflow-wrap:anywhere}.context-meta,.muted{margin:.1rem 0 0;color:var(--muted);font-size:.875rem}.title{margin:0;font-size:clamp(1.55rem,5vw,2rem);line-height:1.18;letter-spacing:-.025em}.lede{margin:.75rem 0 0;color:var(--muted);max-width:62ch}.field{display:grid;gap:.45rem;margin-top:1.5rem}.field label,.legend{font-weight:650}.field input{width:100%;min-height:3rem;border:1px solid var(--line-strong);border-radius:.625rem;padding:.72rem .8rem;color:var(--ink);background:var(--plate)}.field input:hover{border-color:var(--connector)}.field input:focus-visible,.choice:has(input:focus-visible),button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:2px}.help{margin:.45rem 0 0;color:var(--muted);font-size:.875rem}.alert{margin:0 0 1.2rem;padding:.8rem .9rem;border-radius:.625rem;background:var(--danger-soft);color:var(--danger);font-weight:600}.alert--problem{background:oklch(.96 .04 83);color:oklch(.4 .1 83)}.actions{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;flex-wrap:wrap}.button{display:inline-flex;align-items:center;justify-content:center;min-height:3rem;border-radius:.625rem;padding:.65rem 1rem;border:1px solid transparent;font-weight:700;cursor:pointer;text-decoration:none}.button:disabled{cursor:not-allowed;opacity:.55}.button--primary{background:var(--action);color:var(--plate)}.button--primary:hover:not(:disabled){background:var(--action-hover)}.button--secondary{background:var(--plate);border-color:var(--line-strong);color:var(--ink)}.button--secondary:hover:not(:disabled){background:var(--ground)}.button--danger{background:var(--plate);border-color:color-mix(in oklch,var(--danger) 45%,var(--plate));color:var(--danger)}.button--danger:hover:not(:disabled){background:var(--danger-soft)}.section{margin-top:1.7rem}.section:first-child{margin-top:0}.section h2{margin:0;font-size:1.05rem;letter-spacing:-.01em}.section-intro{margin:.35rem 0 .8rem;color:var(--muted);font-size:.9rem}.plain-list{margin:.6rem 0 0;padding-left:1.2rem}.plain-list li+li{margin-top:.35rem}.plain-list code{overflow-wrap:anywhere;font-size:.875rem}.choices{display:grid;gap:.7rem;margin-top:.75rem}.choice{display:grid;grid-template-columns:auto 1fr;gap:.1rem .75rem;border:1px solid var(--line);border-radius:.625rem;padding:.9rem;cursor:pointer}.choice:hover{border-color:var(--line-strong);background:var(--ground)}.choice:has(input:checked){border-color:var(--connector);background:var(--connector-soft)}.choice input{grid-row:1/4;margin:.3rem 0 0}.choice strong,.choice span,.choice small{grid-column:2}.choice span{color:var(--muted)}.choice small{margin-top:.2rem}.disclosure{margin-top:.8rem;border-top:1px solid var(--line);padding-top:.8rem}.disclosure summary{cursor:pointer;font-weight:650;color:var(--ink-raised)}.console-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}.console-head .title{font-size:1.7rem}.grant-list,.profile-list{display:grid;gap:.75rem;margin-top:.85rem}.grant,.profile{padding:1rem 0;border-top:1px solid var(--line)}.grant:first-child,.profile:first-child{border-top:0;padding-top:0}.grant-top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.grant h3,.profile h3{margin:0;font-size:1rem;overflow-wrap:anywhere}.status{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;font-weight:750}.status::before{content:"";width:.48rem;height:.48rem;border-radius:50%;background:currentColor}.status--active{color:var(--success)}.status--expired,.status--revoked{color:var(--muted)}.facts{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .8rem;margin:.8rem 0 0;font-size:.875rem}.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}.facts time{font-variant-numeric:tabular-nums}.grant-actions{display:flex;justify-content:flex-end;margin-top:.9rem}.empty{padding:1rem;border-radius:.625rem;background:var(--ground)}.empty strong{display:block}.empty p{margin:.3rem 0 0;color:var(--muted)}.quiet-details{margin-top:1.5rem}.quiet-details>summary{cursor:pointer;font-weight:700}.footer-note{margin:1rem .2rem 0;color:var(--muted);font-size:.8rem;text-align:center}
.status--pending{color:#805600}.lede+.alert{margin-top:1rem}
.stack--wide{width:min(100%,62rem)}.console{padding:0}.console-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:2rem;padding:clamp(1.25rem,4vw,2rem);border-bottom:1px solid var(--line)}.console-head .title{font-size:2rem}.console-counts{display:flex;align-items:stretch;border:1px solid var(--line);border-radius:.625rem;overflow:hidden}.console-count{display:grid;gap:.05rem;min-width:5rem;padding:.55rem .75rem}.console-count+.console-count{border-left:1px solid var(--line)}.console-count strong{font-size:1.05rem;font-variant-numeric:tabular-nums}.console-count span{color:var(--muted);font-size:.875rem}.console-body{display:grid;gap:1.25rem;padding:clamp(1rem,3vw,1.5rem);background:var(--ground)}.management-section{overflow:hidden;border:1px solid var(--line);border-radius:.625rem;background:var(--plate)}.management-section--attention{border-color:color-mix(in oklch,var(--signal) 45%,var(--line))}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1rem 1.1rem;border-bottom:1px solid var(--line)}.section-heading h2{margin:0;font-size:1.05rem;letter-spacing:-.01em}.section-heading p{margin:.22rem 0 0;color:var(--muted);font-size:.875rem}.section-count{display:grid;place-items:center;flex:0 0 auto;min-width:2rem;height:2rem;border-radius:.625rem;background:var(--soft);font-size:.875rem;font-weight:800;font-variant-numeric:tabular-nums}.management-section--attention .section-count{background:color-mix(in oklch,var(--signal) 18%,var(--plate));color:#805600}.record-list{display:grid}.access-record{padding:1rem 1.1rem}.access-record+.access-record{border-top:1px solid var(--line)}.access-record:hover{background:color-mix(in oklch,var(--ground) 56%,var(--plate))}.record-top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.record-app{display:flex;align-items:center;gap:.75rem;min-width:0}.record-app .app-avatar{width:2.35rem;height:2.35rem}.record-title{min-width:0}.record-title h3{margin:0;font-size:1rem;overflow-wrap:anywhere}.record-id{margin:.1rem 0 0;color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}.record-line{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;margin:.65rem 0 0;color:var(--muted);font-size:.875rem}.record-line strong{color:var(--ink-raised)}.record-line span+span::before{content:"·";margin-right:.55rem;color:var(--line-strong)}.record-actions{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:.9rem}.record-actions .button{min-height:2.5rem;padding:.45rem .8rem}.authority-details{margin:0}.authority-details summary{cursor:pointer;color:var(--connector);font-size:.875rem;font-weight:700}.record-actions form{margin-left:auto}.history{border-top:1px solid var(--line)}.history>summary{cursor:pointer;padding:.9rem 1.1rem;font-weight:700}.history[open]>summary{border-bottom:1px solid var(--line)}.profile-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;padding:1rem;margin:0}.profile{padding:1rem;border:1px solid var(--line);border-radius:.625rem}.profile:first-child{padding-top:1rem;border-top:1px solid var(--line)}.profile h3{margin:0;font-size:1rem}.profile .section-intro{margin:.25rem 0 .75rem}.profile .facts{margin-top:0}.management-section>.empty{margin:1rem}.quiet-details{margin:0}.quiet-details>summary{cursor:pointer;font-weight:700}
.security-list{display:grid}.security-action{display:flex;align-items:center;justify-content:space-between;gap:1.5rem;padding:1rem 1.1rem}.security-action+.security-action{border-top:1px solid var(--line)}.security-action h3{margin:0;font-size:1rem}.security-action p{margin:.2rem 0 0;color:var(--muted);font-size:.875rem;max-width:58ch}.security-action form{flex:0 0 auto}.security-action .button{min-height:2.5rem;padding:.45rem .8rem}
@media(max-width:700px){.console-head{grid-template-columns:1fr;align-items:start;gap:1rem}.console-counts{width:100%}.console-count{flex:1;min-width:0}.profile-list{grid-template-columns:1fr}}
@media(max-width:560px){.page{display:block;padding:0}.stack,.stack--wide{width:100%}.brand{padding:.75rem 1rem;margin:0}.plate{display:flex;flex-direction:column;border-radius:0;box-shadow:none;min-height:calc(100vh - 3rem);min-height:calc(100dvh - 3rem)}.plate>form{display:flex;flex:1;flex-direction:column}.plate>.task-form--compact{flex:0}.plate-body{flex:1}.task-form--compact .plate-body{flex:0}.plate-head,.plate-body,.plate-foot{padding-left:1rem;padding-right:1rem}.plate-foot{position:sticky;bottom:0}.task-form--compact .plate-foot{position:static}.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.button{width:100%}.console-head{display:block}.console-head .muted{margin-top:.4rem}.grant-top{display:block}.status{margin-top:.35rem}.facts{grid-template-columns:1fr}.facts dd{margin-bottom:.35rem}.footer-note{display:none}}
@media(max-width:560px){.console{background:var(--ground)}.console-head{display:grid;background:var(--plate);padding:1.15rem 1rem}.console-body{padding:.8rem}.console-count{padding:.5rem}.section-heading,.access-record{padding:.9rem}.record-top{gap:.65rem}.record-actions,.security-action{align-items:stretch;flex-direction:column}.record-actions form,.security-action form{width:100%;margin:0}.record-actions .button,.security-action .button{width:100%}.authority-details{padding:.25rem 0}.profile-list{padding:.8rem}}
@media(prefers-reduced-motion:no-preference){.button{transition:background-color .16s ease-out,border-color .16s ease-out}.choice{transition:border-color .16s ease-out,background-color .16s ease-out}}
`;

export function ownerLoginPage(input: {
  readonly action: string;
  readonly challenge: string;
  readonly clientId?: string;
  readonly error?: string;
}): string {
  const application = input.clientId
    ? applicationContext(input.clientId, "Owner authentication")
    : "";
  const title = input.clientId ? "Confirm it’s you" : "Owner sign-in";
  const lede = input.clientId
    ? "Enter the enrollment passphrase to review the access this application is requesting."
    : "Enter the enrollment passphrase to inspect and manage application access.";
  const cancel = input.clientId
    ? `<a class="button button--secondary" href="${escapeHtml(input.clientId)}">Cancel</a>`
    : "";
  return page(
    title,
    `${application}<form class="task-form task-form--compact" method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="challenge" value="${escapeHtml(input.challenge)}"><div class="plate-body"><h1 class="title">${title}</h1><p class="lede">${lede}</p>${input.error ? `<p class="alert" id="login-error" role="alert">${escapeHtml(input.error)}</p>` : ""}<div class="field"><label for="passphrase">Enrollment passphrase</label><input id="passphrase" type="password" name="passphrase" autocomplete="current-password" required${input.error ? ' aria-describedby="login-error passphrase-help"' : ' aria-describedby="passphrase-help"'}><p class="help" id="passphrase-help">Use the passphrase created when this gateway was enrolled.</p></div></div><div class="plate-foot actions">${cancel}<button class="button button--primary" type="submit">Continue</button></div></form>`,
  );
}

export function consentPage(input: {
  readonly clientId: string;
  readonly action: string;
  readonly requestUri: string;
  readonly csrfToken: string;
  readonly tools: readonly string[];
  readonly defaultPolicyIndex: number;
  readonly policies: readonly {
    readonly label: string;
    readonly description?: string;
    readonly nativeCapabilities: readonly string[];
  }[];
}): string {
  const tools = input.tools.length
    ? `<ul class="plain-list">${input.tools.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join("")}</ul>`
    : '<p class="section-intro">This application did not request any application tools.</p>';
  const policies = input.policies
    .map((policy, index) => {
      const capabilities = policy.nativeCapabilities.length
        ? policy.nativeCapabilities.map(humanCapability).join(", ")
        : "No native OpenClaw capabilities";
      return `<label class="choice"><input type="radio" name="policy_choice" value="${index}"${index === input.defaultPolicyIndex ? " checked" : ""} required><strong>${escapeHtml(policy.label)}</strong><span>${escapeHtml(policy.description ?? capabilities)}</span><small>${escapeHtml(capabilities)}</small></label>`;
    })
    .join("");
  return page(
    "Review access",
    `${applicationContext(input.clientId, "Authorization request")}<form class="task-form" method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="request_uri" value="${escapeHtml(input.requestUri)}"><input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}"><div class="plate-body"><h1 class="title">Review access</h1><p class="lede">Choose the restricted profile this application may use. You can revoke this access later from the owner console.</p><section class="section" aria-labelledby="profile-heading"><h2 id="profile-heading">Restricted profile</h2><p class="section-intro">Agent Connect offers only profiles configured by the gateway owner.</p><div class="choices">${policies}</div></section><details class="disclosure"><summary>Application tools (${input.tools.length})</summary>${tools}</details><details class="disclosure"><summary>Native OpenClaw capabilities</summary><p class="section-intro">Native capabilities come only from the profile selected above. They are separate from application tools.</p></details></div><div class="plate-foot actions"><button class="button button--secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button><button class="button button--primary" type="submit" name="decision" value="allow">Allow access</button></div></form>`,
  );
}

export function ownerConsolePage(input: {
  readonly grants: readonly (DelegatedGrantView & {
    readonly status: "active" | "expired" | "revoked";
    readonly profileLabel?: string;
    readonly revokeCsrfToken?: string;
  })[];
  readonly pending: readonly {
    readonly clientId: string;
    readonly requestUri: string;
    readonly applicationToolNames: readonly string[];
    readonly expiresAt: string;
  }[];
  readonly authorizationPath: string;
  readonly policies: readonly {
    readonly label: string;
    readonly description?: string;
    readonly agentId: string;
    readonly nativeCapabilities: readonly DelegatedNativeCapability[];
  }[];
  readonly revokeAction: string;
  readonly revokeAllAction: string;
  readonly revokeAllCsrfToken: string;
  readonly forgetAction: string;
  readonly forgetCsrfToken: string;
  readonly runtimeProblem?: string;
}): string {
  const active = input.grants.filter((grant) => grant.status === "active");
  const inactive = input.grants.filter((grant) => grant.status !== "active");
  const activeHtml = active.length
    ? `<div class="record-list">${active.map((grant) => grantHtml(grant, input.revokeAction)).join("")}</div>`
    : '<div class="empty"><strong>No active application access</strong><p>Approved applications will appear here after authorization completes.</p></div>';
  const inactiveHtml = inactive.length
    ? `<details class="history"><summary>Past access (${inactive.length})</summary><div class="record-list">${inactive.map((grant) => grantHtml(grant, input.revokeAction)).join("")}</div></details>`
    : "";
  const profiles = input.policies.length
    ? `<div class="profile-list">${input.policies.map(profileHtml).join("")}</div>`
    : '<div class="empty"><strong>Profiles unavailable</strong><p>Review the gateway configuration and restart state before authorizing new access.</p></div>';
  const pending = input.pending.length
    ? `<div class="record-list">${input.pending
        .map((request) => {
          const search = new URLSearchParams({
            client_id: request.clientId,
            request_uri: request.requestUri,
          }).toString();
          const tools = request.applicationToolNames.length
            ? request.applicationToolNames.join(", ")
            : "No application tools";
          return `<article class="access-record"><div class="record-top">${recordApplication(request.clientId)}<span class="status status--pending">Pending</span></div><p class="record-line"><span><strong>Tools</strong> ${escapeHtml(tools)}</span><span><strong>Expires</strong> ${formatDate(request.expiresAt)}</span></p><div class="record-actions"><span class="muted">Waiting for your decision</span><a class="button button--primary" href="${escapeHtml(`${input.authorizationPath}?${search}`)}">Review request</a></div></article>`;
        })
        .join("")}</div>`
    : '<div class="empty"><strong>No decisions waiting</strong><p>New application requests will appear here until they expire or are completed.</p></div>';
  return page(
    "Owner console",
    `<div class="console"><header class="console-head"><div><h1 class="title">Application access</h1><p class="lede">Review requests and manage the authority applications hold through this gateway.</p></div><div class="console-counts" aria-label="Access summary"><span class="console-count"><strong>${input.pending.length}</strong><span>Pending</span></span><span class="console-count"><strong>${active.length}</strong><span>Active</span></span><span class="console-count"><strong>${input.policies.length}</strong><span>Profiles</span></span></div></header><div class="console-body">${input.runtimeProblem ? `<p class="alert alert--problem" role="status">${escapeHtml(input.runtimeProblem)}</p>` : ""}<section class="management-section management-section--attention" aria-labelledby="pending-requests"><header class="section-heading"><div><h2 id="pending-requests">Pending requests</h2><p>Requests expire automatically if you take no action.</p></div><span class="section-count" aria-label="${input.pending.length} pending requests">${input.pending.length}</span></header>${pending}</section><section class="management-section" aria-labelledby="active-grants"><header class="section-heading"><div><h2 id="active-grants">Application access</h2><p>Active grants remain in effect until they expire or you revoke them.</p></div><span class="section-count" aria-label="${active.length} active grants">${active.length}</span></header>${activeHtml}${inactiveHtml}</section><section class="management-section" aria-labelledby="profiles"><header class="section-heading"><div><h2 id="profiles">Restricted profiles</h2><p>Gateway-owned profiles available when you review a request.</p></div><span class="section-count" aria-label="${input.policies.length} restricted profiles">${input.policies.length}</span></header>${profiles}</section><section class="management-section" aria-labelledby="browser-security"><header class="section-heading"><div><h2 id="browser-security">Browser and access</h2><p>Use these controls before leaving a shared or borrowed device.</p></div></header><div class="security-list"><div class="security-action"><div><h3>Forget this browser</h3><p>End this owner-console session. Application grants remain active.</p></div><form method="post" action="${escapeHtml(input.forgetAction)}"><input type="hidden" name="csrf_token" value="${escapeHtml(input.forgetCsrfToken)}"><button class="button button--secondary" type="submit">Forget this browser</button></form></div><div class="security-action"><div><h3>Revoke all application access</h3><p>Immediately revoke all ${active.length} active ${active.length === 1 ? "grant" : "grants"}. This browser stays signed in.</p></div><form method="post" action="${escapeHtml(input.revokeAllAction)}"><input type="hidden" name="csrf_token" value="${escapeHtml(input.revokeAllCsrfToken)}"><button class="button button--danger" type="submit"${active.length === 0 ? " disabled" : ""}>Revoke all active grants</button></form></div></div></section></div></div>`,
    true,
  );
}

export function ownerForgottenPage(ownerConsolePath: string): string {
  return page(
    "Browser forgotten",
    `<div class="plate-body"><h1 class="title">This browser has been forgotten</h1><p class="lede">The owner-console session ended on this browser. Application grants were not changed.</p><div class="field"><a class="button button--secondary" href="${escapeHtml(ownerConsolePath)}">Sign in again</a></div></div>`,
  );
}

export function errorPage(message: string): string {
  return page(
    "Authorization unavailable",
    `<div class="plate-body"><h1 class="title">Authorization unavailable</h1><p class="alert alert--problem" role="alert">${escapeHtml(message)}</p><p class="lede">Return to the application and start the connection again. No access was granted.</p></div>`,
  );
}

function grantHtml(
  grant: DelegatedGrantView & {
    readonly status: "active" | "expired" | "revoked";
    readonly profileLabel?: string;
    readonly revokeCsrfToken?: string;
  },
  revokeAction: string,
): string {
  const tools = grant.applicationTools.length
    ? grant.applicationTools.map((tool) => tool.name).join(", ")
    : "None";
  const native = grant.nativeCapabilities.length
    ? grant.nativeCapabilities.map(humanCapability).join(", ")
    : "None";
  const action =
    grant.status === "active" && grant.revokeCsrfToken
      ? `<form method="post" action="${escapeHtml(revokeAction)}"><input type="hidden" name="grant_id" value="${escapeHtml(grant.grantId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(grant.revokeCsrfToken)}"><button class="button button--danger" type="submit">Revoke access</button></form>`
      : "";
  return `<article class="access-record"><div class="record-top">${recordApplication(grant.clientId)}<span class="status status--${grant.status}">${capitalize(grant.status)}</span></div><p class="record-line"><span><strong>Profile</strong> ${escapeHtml(grant.profileLabel ?? grant.policyRef)}</span><span><strong>Expires</strong> ${formatDate(grant.grantExpiresAt)}</span></p><div class="record-actions"><details class="authority-details"><summary>View authority details</summary><dl class="facts"><dt>Policy revision</dt><dd>${escapeHtml(grant.policyRef)}</dd><dt>Application tools</dt><dd>${escapeHtml(tools)}</dd><dt>Native capabilities</dt><dd>${escapeHtml(native)}</dd><dt>Created</dt><dd>${formatDate(grant.createdAt)}</dd></dl></details>${action}</div></article>`;
}

function recordApplication(clientId: string): string {
  const label = applicationLabel(clientId);
  return `<div class="record-app"><div class="app-avatar" aria-hidden="true">${escapeHtml(label.slice(0, 1))}</div><div class="record-title"><h3>${escapeHtml(label)}</h3><p class="record-id">${escapeHtml(clientId)}</p></div></div>`;
}

function profileHtml(policy: {
  readonly label: string;
  readonly description?: string;
  readonly agentId: string;
  readonly nativeCapabilities: readonly DelegatedNativeCapability[];
}): string {
  const native = policy.nativeCapabilities.length
    ? policy.nativeCapabilities.map(humanCapability).join(", ")
    : "No native OpenClaw capabilities";
  return `<article class="profile"><h3>${escapeHtml(policy.label)}</h3><p class="section-intro">${escapeHtml(policy.description ?? native)}</p><dl class="facts"><dt>Restricted agent</dt><dd>${escapeHtml(policy.agentId)}</dd><dt>Native capabilities</dt><dd>${escapeHtml(native)}</dd></dl></article>`;
}

function applicationContext(clientId: string, meta: string): string {
  const label = applicationLabel(clientId);
  return `<header class="plate-head"><div class="context"><div class="app-avatar" aria-hidden="true">${escapeHtml(label.slice(0, 1))}</div><div class="context-copy"><p class="context-name">${escapeHtml(label)}</p><p class="context-meta">${escapeHtml(meta)} · ${escapeHtml(clientId)}</p></div></div></header>`;
}

function page(title: string, contents: string, wide = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)} · Agent Connect</title><style>${PAGE_STYLES}</style></head><body><main class="page"><div class="stack${wide ? " stack--wide" : ""}"><p class="brand"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>Agent Connect</p><section class="plate">${contents}</section><p class="footer-note">This authorization surface is served by your own gateway.</p></div></main></body></html>`;
}

function applicationLabel(clientId: string): string {
  try {
    return new URL(clientId).hostname;
  } catch {
    return clientId;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  const text = Number.isNaN(date.valueOf())
    ? value
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(text)}</time>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] as string;
  });
}

function humanCapability(capability: string): string {
  if (capability === "public_web_search") return "Public web search";
  if (capability === "sandbox_code_execution") return "Isolated code sandbox";
  return capability;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
