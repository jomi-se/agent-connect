# OpenClaw gateway setup (replacement branch)

This is isolated setup for the proposed replacement, not a live cutover procedure.
The subscription-backed runtime choice remains pending. Native Codex client-tool
support is not established; the deterministic test uses the **built-in OpenClaw
runtime**. Do not silently switch a user's harness or subscription to another route.

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
state. Final migration/startup and subscription instructions require the runtime
decision and real acceptance evidence before this branch can become the default.
