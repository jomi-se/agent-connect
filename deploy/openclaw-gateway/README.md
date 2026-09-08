# Stock OpenClaw scoped-proxy setup

This is the current setup on `work/openclaw-scoped-proxy`. Agent Connect is a
small authorization/request-confinement proxy; the pinned published OpenClaw
process owns Responses execution. No OpenClaw core patch or Agent Connect plugin
is installed. The parent native-patch experiment and the older replacement
engine remain in the repository for review/rollback only.

## Security and lifecycle contract

- Both processes listen on loopback. An operator-managed HTTPS ingress may expose
  only discovery, delegated OAuth/owner-login, `POST /v1/responses`, the scoped
  cancel extension, `GET /v1/agent-connect/conversations`, its scoped `history`
  child route and optional health. There is no catch-all upstream proxy.
- Private/tailnet reachability is not owner identity. Consent uses the one-time
  gateway enrollment secret to create an HttpOnly owner session. Forwarding and
  `Tailscale-User-Login` headers are ignored for owner authentication and rejected
  on Responses.
- `OPENCLAW_TOKEN` is the stock operator bearer. Keep it in the two private local
  configuration files only: the proxy env and OpenClaw's JSON. Never put it in a
  browser, URL, command argument, frontend environment, shared log or runtime
  card. Upstream subscription/API credentials remain entirely OpenClaw-owned.
- OpenClaw config reload is off. On startup and immediately before each Responses
  admission, the proxy authenticates to the same stock Gateway and calls
  `config.get`. It requires the saved resolved revision to equal the running
  applied revision and the startup pin. It also hashes the full private config
  and policy files because the stock response redacts credentials. To change
  either, stop both services, replace the files, restart OpenClaw, restart the
  proxy and obtain fresh app consent. This detects accidental drift; it is not an
  atomic fence against a trusted operator changing config concurrently.
- Continuation mappings are process-local, capped, single-use and expire after 30
  minutes. Proxy restart, grant expiry/revocation, policy change or an ambiguously
  admitted failure ends that conversation. Nothing is replayed automatically and
  no exactly-once guarantee is made.
- Conversation reads expose only the current grant's live registry entries and a
  bounded user/assistant text projection from stock `chat.history`. Native inputs
  are prompt-or-application-output, never a reliable **You** role. Reads do not
  extend expiry or execute/replay a tool.
- Responses requests have a fixed 20 MiB encoded-JSON cap, matching the pinned
  OpenClaw default. Tool outputs have no smaller independent size cap; JSON
  escaping, multiple results and the tool catalog count toward the total. Chat
  text retains its smaller limit. Results are never silently truncated.

## Prepare private configuration

Use Node 24 LTS `>=24.15.0` and `<25`. Install the published pin into a new
absolute prefix with the integrity-checking installer:

```sh
node scripts/openclaw-install.mjs /absolute/new/pinned-openclaw
```

Copy all examples outside the checkout or to ignored private files, replace every
placeholder literally, and make them owner-only:

```sh
cp deploy/openclaw-gateway/openclaw.scoped-proxy.example.json /absolute/private/openclaw-scoped/openclaw.json
cp deploy/openclaw-gateway/scoped-policies.example.json /absolute/private/agent-connect/scoped-policies.json
cp deploy/openclaw-gateway/.env.scoped-proxy.example deploy/openclaw-gateway/.env.scoped-proxy
chmod 600 /absolute/private/openclaw-scoped/openclaw.json
chmod 600 /absolute/private/agent-connect/scoped-policies.json
chmod 600 deploy/openclaw-gateway/.env.scoped-proxy
```

The example policy offers one app-tools-only agent. Its workspace must be a
dedicated private empty directory, never the owner's normal OpenClaw workspace.
Every agent named by an offered policy, its selected model entry, and all
inherited agent/tool/plugin layers are checked against the narrow safe template.
Unrelated personal agents, model entries, provider definitions and auth profiles
may coexist, but are not certified or reachable through an app grant. Multiple
policies may name distinct closed agents. Offered agents require disabled
heartbeat, context injection, skills, search memory, bootstrap, memory plugins,
model fallbacks, tool search and elevation. A policy that adds
`sandbox_code_execution` must use exactly `exec` and `process` with a per-session
Docker/Podman sandbox, no network, no host binds and read-only or absent host
workspace access. Conditional/global tool layers and unknown execution fields on
offered or inherited policy remain unsupported.

The OpenClaw JSON contains the upstream operator token literally so the proxy can
compare it without resolving shell/config substitutions. The same literal value
goes in `OPENCLAW_TOKEN` in the private proxy env. Do not use the placeholder form
from the older subscription example on this path.

## Initialize, verify and serve

Build once. For a **new owner identity only**, initialize and save the printed
secret in the owner's password manager. Existing identity files are never
reinitialized.

```sh
npm run build:scoped-proxy
export AGENT_CONNECT_OPENCLAW_ENV_FILE=/absolute/repository/deploy/openclaw-gateway/.env.scoped-proxy
node scripts/openclaw-scoped-proxy.mjs initialize
```

Start the pinned stock OpenClaw binary under a supervisor with exactly the private
`OPENCLAW_CONFIG_PATH`, state/home/cache directories and credential environment
selected by the operator. This repository deliberately does not orchestrate or
restart that service. Once it is healthy, the read-only preflight validates the
package provenance, static config/policy, owner/grant state, authenticated stock
`config.get` redaction and saved/applied revision equality, and loopback health
without an inference call:

```sh
node scripts/openclaw-scoped-proxy.mjs check
node scripts/openclaw-scoped-proxy.mjs serve
```

The proxy does not currently install or edit OpenClaw profiles. A future
operator-only setup assistant can preserve an existing profile without becoming
an app-facing config API: use authenticated `config.schema.lookup` for the paths
it proposes, call `config.get`, generate and display a minimal patch, and apply
only after explicit owner approval with `config.patch` and the fresh raw `hash`
as `baseHash`. Object-valued named agents should be merged by name. Any array
replacement must be shown explicitly and use the server's `replacePaths`
contract; a stale base hash must abort rather than overwrite concurrent edits.
After an approved write, repeat `config.get`, then follow the controlled
stop/restart/reconsent lifecycle above. This assistant is advisory future work;
applications must never receive `config.get`, `config.patch`, or the operator
credential.

The stock compatibility gates use deterministic inference and no subscription:

```sh
export OPENCLAW_TEST_BIN=/absolute/new/pinned-openclaw/node_modules/.bin/openclaw
npm run test:openclaw:fixture
npm run test:integration:openclaw
```

The first consent navigation shows an explicit owner sign-in form. Enter the
saved gateway enrollment secret there; never paste OpenClaw credentials. After
sign-in, the unchanged SDK completes PAR/PKCE consent, token exchange and normal
AI SDK use against `openclaw/default`.

## Retained replacement/native experiment material

The remainder of this document describes the parent replacement/native
experiment and selected subscription bootstrap. It is retained as historical
evidence only. **Do not run these commands to install the current gateway.** Its
launcher, response ledger, plugin build and patched-source steps target a
superseded implementation; use only the scoped-proxy recipe above.

---

## Earlier replacement branch setup

The selected runtime is the **built-in OpenClaw loop**, using the operator's
existing ChatGPT subscription, not native Codex app-server execution. Pin
`openai/gpt-5.6-sol` and model-scoped `agentRuntime.id: "openclaw"` explicitly.
Do not silently switch the harness, model, account, or billing route. The native
Codex client-tool gap is not a prerequisite for this selected path.

## Pinned dependency and deterministic compatibility

Use Node **24 LTS, >=24.15.0 and <25**, then install the pinned dependency into a new,
dedicated absolute directory:

```sh
node scripts/openclaw-install.mjs /absolute/new/openclaw-test-install
export OPENCLAW_TEST_BIN=/absolute/new/openclaw-test-install/node_modules/.bin/openclaw
npm run test:integration:openclaw
```

The destination's parent directory must exist. The installer refuses an existing directory and does not run onboarding, modify
a personal OpenClaw profile, or install into the repository. It installs exactly
the tarball version and SHA-512 integrity in `config/openclaw-test-compat.json`
(transitive dependencies are resolved by npm, not frozen by this file). The verified
archive remains in the install prefix so npm's local tarball dependency can be
reused. Tests reject an incompatible
Node or OpenClaw version, with no automatic installation or fallback. Keep the
supported Node binary on `PATH` because the OpenClaw executable uses its shebang.

The fixture starts the actual published gateway on loopback, using an isolated
temporary home/state/config/cache/workspace and a random owner token. Only the
OpenAI-compatible inference endpoint is deterministic. No subscription, real
provider credentials, or model allowance is needed. Services are stopped in
`finally`; evidence and disposable state remain in the printed temporary directory
for failure investigation. Those files include a throwaway owner token; do not
publish the configuration. The provider's `agentRuntime.id` is explicitly
`openclaw`, and `tools.deny: ["*"]` disables host tools while the fixture verifies
that the approved request-scoped application tool reaches inference.

`scripts/openclaw-test-runtime.mjs` exports `startOpenClawTestRuntime` for gateway
integration tests. It returns `baseUrl`, server-only `token`, `agentId`, `model`,
`directory`, observed `modelRequests`, `request(...)`, and async `close()`. Pass an
`onModelRequest(body, inference)` callback to reply with `inference.text(...)`,
`inference.tool(name, arguments)`, or `inference.hang()`. This callback must not
simulate OpenClaw Responses, session behavior, or cancellation. Always close the
fixture in `finally` and use one explicit private session key for continuations.

The compatibility test exercises streaming tool calls, streamed output
continuation, non-streaming follow-up, offered-tool isolation and actual inference
connection lifetime after a client disconnect. A fixed 20-second agent timeout
bounds the test's hanging inference; the test requires closure within five seconds
of disconnect, before that timeout, and records the measured latency. This test does not prove live model judgment or native
tool-result semantics: the pinned built-in runtime presents client output as user
text following a synthetic delegated-tool result.

## Operator boundary (runtime-neutral)

The launcher connects to an **already running, operator-configured OpenClaw**. It
does not install a model, link subscription credentials, start/restart OpenClaw,
or choose a harness. Before release, the chosen upstream agent must have its
runtime/model explicitly configured, request-scoped client tools proven, and host
tools disabled. The deterministic fixture is not a substitute for that profile.

Build Agent Connect and prepare the private environment file from `.env.example`.
Use literal values: the Node dotenv loader does **not** evaluate the old shell
profile's `$HOME`, command substitution, or shell interpolation. Existing process
environment values take precedence over dotenv values. Do not carry over old
Omnigent/Codex launch settings; upstream credentials and configuration belong to
the separately operated OpenClaw service.

```sh
npm run build --workspace @agent-connect/gateway
cp deploy/openclaw-gateway/.env.example deploy/openclaw-gateway/.env
chmod 600 deploy/openclaw-gateway/.env
# Edit the file with private, literal values before continuing.
export AGENT_CONNECT_OPENCLAW_ENV_FILE=/absolute/repository/deploy/openclaw-gateway/.env
node scripts/openclaw-gateway.mjs check
node scripts/openclaw-gateway.mjs serve
```

For an entirely **new identity only**, run `node scripts/openclaw-gateway.mjs
initialize` before `check`. It intentionally prints the one-time enrollment
secret; run it interactively, save the secret privately, and do not capture it in
shared logs. Existing state is never reinitialized. For migration, select the
existing `connector.json` identity path and a separate OpenClaw response-ledger
path; preserve the original files for rollback.

`check` validates the supported Node version, basic private routing configuration,
build/identity presence and upstream health, without creating sessions or spending
model allowance. Health availability does not prove token authorization or the
selected runtime's client-tool support: run the real integration suite and the
authorized selected-runtime smoke for those. The launcher redacts upstream health
failure bodies, refuses plaintext remote upstream URLs and nonloopback listeners,
and never places the upstream token in command-line arguments. HTTPS publication
and service supervision remain operator-owned; no Tailscale or live service
configuration is changed automatically.

Run the upstream on loopback or a separately protected private network. Its owner
token belongs only in Agent Connect's server configuration, never the app SDK,
browser, URL, frontend environment, or returned session payload. Agent Connect
must pin the agent, public model selector and private session routing itself;
do not proxy caller-supplied OpenClaw routing headers. The test profile is not an
approved production subscription profile.

Preserve existing Agent Connect identity and grants during migration. Old
Omnigent conversations cannot become OpenClaw conversations: require new sessions
or report old ones explicitly interrupted. Keep the old checkout and its original
state available for rollback; never reinterpret OpenClaw session state as Omnigent
state. Final deployment still requires real acceptance evidence and explicit
operator coordination; choosing the built-in loop does not authorize changing
other running gateways or public routes.

## Existing ChatGPT subscription: runtime-only bootstrap

[openclaw.subscription.example.json](openclaw.subscription.example.json) is the
secret-free upstream profile. Its `${OPENCLAW_GATEWAY_TOKEN}` placeholder is an
OpenClaw config environment reference, separate from the downstream dotenv file.
Use an isolated `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` and
cache/workspace; explicitly reference the existing `CODEX_HOME` read-only. Start
with an empty OpenClaw auth store, no provider API-key variables, and
`OPENCLAW_SKIP_CRON=1` / `OPENCLAW_SKIP_CHANNELS=1` for this application-only profile.

The reviewed pin can read existing, unexpired Codex CLI OAuth from an explicitly
selected `CODEX_HOME` when the isolated OpenClaw auth store has no managed OpenAI
OAuth material. It exposes a runtime-only `openai:default` profile. Do not copy
`auth.json`, import tokens into OpenClaw, log in again, or establish a second
refresh owner. Configure OAuth-only auth order, no model fallbacks, disabled host
tools and no API-key variables in the child environment. See the
[source and refresh-ownership review](../../docs/research/2026-09-05-openclaw-subscription-auth.md).

`scripts/openclaw-subscription-smoke.mjs` is an **explicit, real-subscription**
operator test, never part of credential-free verification. With Node 24 LTS >=24.15 on
`PATH` and `OPENCLAW_TEST_BIN` pointing to the pinned installation, pass a new
absolute durable profile path and the existing Codex home:

```sh
node scripts/openclaw-subscription-smoke.mjs /absolute/private/new-openclaw-profile /absolute/existing-codex-home
```

It refuses an existing profile by default, API-key source, expired access token, or access
token within ten minutes of expiry. It starts a loopback upstream, asks for one
application tool, generates the unpredictable result only after the call, and
checks actual result consumption and follow-up. Failures stop the upstream with
no application-level retry, new login, token refresh, or billing fallback. A
successful run leaves the private upstream running for Agent Connect composition
and writes private config/token references plus a credential audit—not credential
values—to `summary.json`. An explicitly approved corrected test may use `--resume`
after a failed, stopped run; it preserves the existing owner token/port, re-audits
the auth store before startup, and writes fresh evidence into an attempt directory.
The profile retains private wire/log evidence. Never
publish its `openclaw.json` or `gateway-token` file.

Disable memory plugins with `plugins.slots.memory: "none"` and
`plugins.entries.memory-core.enabled: false`, in addition to host-tool denial and
disabled recurring heartbeat/cron. This is a subscription-only boundary, not a
performance tweak: the first live test showed default memory sync attempting
OpenAI API embeddings and receiving `billing_not_active`, even while subscription
inference succeeded. The corrected profile must show no embedding requests in
its fresh logs. Do not describe the first attempt as free of API-route requests.

The helper compares the source credential file before/after, scans the profile
for source credential bytes and inspects SQLite auth-store rows for managed OpenAI
OAuth material before and after the smoke. This is a bounded reuse test, not
a promise of unattended credential lifecycle management. Codex remains the refresh
owner; access-token expiry or auth failure requires operator direction, not a
silent login/refresh operation by this helper.
