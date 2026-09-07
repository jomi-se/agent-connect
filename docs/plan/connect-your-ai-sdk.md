# Connect your AI: AI SDK execution seam

Date: 2026-09-06.
Status: thin model/tool/continuation adapters implemented with a temporary
reviewed downstream dependency patch; deterministic real OpenClaw composition
passes. Native application-grant authorization and live Bookhand consent/tool
execution now work; see the compact handoff for current acceptance evidence.

This is the execution-layer companion to
[`connect-your-ai-openclaw.md`](connect-your-ai-openclaw.md). It records the
exact published dependency behavior behind the implementation rather than
guessing from the Open Responses protocol shape.

## Pinned dependency surface

The implementation pins `ai@7.0.93`, `@ai-sdk/open-responses@2.0.39`, and
`zod@4.1.11`. The two AI SDK packages resolve their shared provider boundary to
`@ai-sdk/provider@4.0.10` and `@ai-sdk/provider-utils@5.0.36`.

`createAiSdkOpenResponsesModel` accepts only the already-selected Responses POST
endpoint, model id, a bearer getter, and an optional fetch implementation. The
getter runs for every HTTP attempt, so credential refresh does not require
rebuilding the model. It does not define OAuth discovery, token storage, or an
OpenClaw-specific authorization endpoint. Abort signals, HTTP failures, and
stream failures pass through the public AI SDK/provider path. The bearer is
attached only to the exact configured URL and authenticated requests use
`redirect: "error"`; URL credentials and fragments are rejected. HTTPS is the
default, with plain HTTP limited to loopback unless a development-only opt-in is
set explicitly.

### Persistent credentials are application-owned

`createOpenClawAccessTokenGetter` refreshes on demand within one minute of
access-token expiry. Provider defaults are one-hour access tokens and a fixed
30-day grant deadline; rotating refresh tokens do not extend that deadline.
Refresh does not invoke inference. The getter is single-flight within one
instance, not across tabs.

Applications that persist a connection must validate its origin, endpoint,
client identity and approved tool association before reuse. Serialize the full
read-current/refresh/save transaction across tabs; compare-and-swap alone
cannot prevent simultaneous use of a rotating refresh token. Keep the lock
until refresh and persistence finish even if a caller aborts waiting. An
uncertain refresh must not retry the old token after reload. Coordinate
disconnect/replacement with the same stored connection identity. Remembering
the non-secret provider address is independent from retaining credentials.

`createAiSdkApplicationTools` converts an already-selected fixed
`ApplicationTool[]` snapshot into an AI SDK `ToolSet`. Bookhand can lend its
page-owned handlers directly. Native callers can pass the `.tools` from one
`createWebMcpToolSnapshot` call; the bridge never performs another discovery.
Arguments use the SDK's existing CSP-safe draft-7 validator before local
execution. Registry change still invalidates the native snapshot at its owner.

## Published continuation behavior

The published Open Responses adapter's internal request type contains
`previous_response_id`, but the public `OpenResponsesLanguageModelOptions`
contains only `reasoningEffort` and `reasoningSummary`, and
`OpenResponsesLanguageModel.getArgs` never writes `previous_response_id` into
the body. This was checked from the exact npm tarball for version 2.0.39:

- `packages/open-responses/src/responses/open-responses-api.ts` declares the wire field;
- `packages/open-responses/src/responses/open-responses-language-model-options.ts` omits it;
- `packages/open-responses/src/responses/open-responses-language-model.ts` builds the body without it.

AI SDK 7.0.93's `streamText` assigns the next step's messages to the current
step input plus `toResponseMessages(...)`. The Open Responses adapter converts
that accumulated history into user/assistant input items and
`function_call_output`. Therefore a multi-step function call replays the full
accumulated transcript. It does **not** automatically send
`previous_response_id`. The focused web-SDK test captures both actual request
bodies through these pinned public packages and locks down that observation.

Transcript replay can produce a stateless answer, but it does not preserve an
OpenClaw-native conversation/workspace. No vertical-success claim may be based
on that substitution.

## Temporary downstream patch and upstreamable addition

The required change belongs in `@ai-sdk/open-responses`, not in an Agent Connect
fetch-body interceptor or a second tool loop. The reviewed patch is persisted as
[`patches/@ai-sdk+open-responses+2.0.39.patch`](../../patches/@ai-sdk+open-responses+2.0.39.patch)
and applies these two upstream-compatible additions:

1. Add nullable/optional `previousResponseId` to
   `OpenResponsesLanguageModelOptions` and map it to request
   `previous_response_id` in `getArgs`.
2. On `response.created`, emit the standard AI SDK `response-metadata` stream
   part with `chunk.response.id`, timestamp, and model id. Non-streaming already
   returns the provider response id. AI SDK's public stream machinery already
   copies `response-metadata.id` to each `StepResult.response.id`.

The patch also exports a downstream-only version marker. The continuation
helper checks it and fails closed when a consumer has the unpatched npm
dependency, instead of silently sending function outputs without their
provider checkpoint. The marker is packaging protection, not part of the
upstream proposal.
With that addition, the consuming `streamText` call can use public
`prepareStep` only. Step zero supplies either no checkpoint with the initial
messages, or a prior top-level checkpoint with only the new user input. Each
later tool step sets `previousResponseId` to the preceding
`steps.at(-1).response.id` and supplies only the preceding step's `tool` role
message(s), because the referenced provider response already owns the
assistant function call. `createAiSdkOpenResponsesPrepareStep` implements this
composition. Applications should normally spread
`createAiSdkOpenResponsesGenerationOptions(checkpoint)` into every
`generateText` or `streamText` invocation. It couples that callback with
`maxRetries: 0`, because retrying an ambiguously admitted Responses request can
duplicate work or reach a mutating tool twice. A focused test drives a retryable
500 through the actual AI SDK and proves there is one request while the original
provider error remains available. `selectAiSdkOpenResponsesCheckpoint` advances
to the terminal successful text response id only; errors, content-filter
refusals, incomplete responses, and unresolved tool calls retain the previous
checkpoint. Retaining the old id after an ambiguously admitted failure is not
proof that continuing from it is safe: the caller must interrupt that
conversation and must not replay the uncertain request.

The root pins `patch-package@8.0.1` and applies the artifact from `postinstall`.
A clean isolated install was used to confirm that the patch applies to the exact
2.0.39 tarball and exposes both additions. This is intentionally a temporary
downstream patch, not an unpublished edit to `node_modules`.

The patch does not automatically travel with a published
`@open-agent-connect/web` dependency. Until an upstream release contains the
same additions, a consuming application checkout such as Bookhand must also:

1. resolve `@ai-sdk/open-responses` exactly to 2.0.39;
2. copy the reviewed patch to its root `patches/` directory;
3. pin `patch-package@8.0.1` and run `patch-package` from root `postinstall`.

Do not publish or deploy the continuation helper while assuming an unpatched
npm consumer will work. Replace this temporary application-side setup with an
exact upstream release pin as soon as the addition is published, then remove
the patch, marker check, and install hook together.

## Deterministic real-OpenClaw result

`scripts/openclaw-ai-sdk.test.mjs` passes against the pinned real
`openclaw@2026.9.1` gateway under supported Node 24.15.0. Deterministic inference
requested two distinct application tools in sequence. The AI SDK executed each
once, sent each continuation as only `function_call_output` plus the preceding
response id, selected the final provider response id, and then completed a
top-level contextual follow-up through the same explicit OpenClaw session key.
The inference-side histories contained each unique application result once, so
the test also rejects duplicated transcript projection. Four Responses requests
and four requests to the deterministic inference fixture were observed.

The test uses the disposable runtime's owner token only inside the test and adds
OpenClaw's private routing headers in its supplied fetch. It proves
AI SDK/Responses/OpenClaw built-in-loop composition and native OpenClaw session
history; it does not prove the application-grant authorization boundary, native
Codex client tools, or model judgment.

## Remaining proof

- Exercise AI SDK cancellation and failed/interrupted application-tool mutations
  through real OpenClaw without automatic replay.
- Repeat the composition path through the enforced application grant once the
  provider-owned authorization seam is integrated.
