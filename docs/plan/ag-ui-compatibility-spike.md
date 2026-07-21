# AG-UI compatibility spike

Date: 2026-07-14

Status: pending exploration; not on the current critical path.

## Goal

Determine whether AG-UI can replace Agent Connect's custom browser/gateway task
wire while preserving the proven Omnigent/Codex composition and the stronger
Agent Connect security and durability model.

## Baseline

The oracle is the passing Firebase/browser flow:

```text
browser-defined tool
  -> Agent Connect gateway
  -> Omnigent session with request-scoped tools
  -> codex-acp
  -> Codex tool call
  -> application tool result
  -> same Codex turn completes
```

The spike must run beside this path. It must not delete or silently migrate the
existing endpoint before the decision gate passes.

## Investigation slice

1. Pin the evaluated AG-UI specification and official TypeScript package
   versions.
2. Inventory the minimum types and events required for:
   - run input and user messages;
   - frontend tool definitions;
   - run lifecycle and streamed assistant text;
   - tool-call arguments and tool-result messages;
   - cancellation, failure, and interruption;
   - thread/run identifiers and reconnect behavior.
3. Document unsupported AG-UI capabilities and required failure behavior.
4. Determine whether standard extension points can carry required action
   correlation without changing core event schemas.

## Adapter slice

Implement an experimental gateway-owned adapter:

```text
AG-UI RunAgentInput
  -> existing logical session and tool-snapshot validation
  -> Omnigent message event with OpenAI-format function tools

Omnigent response stream
  -> AG-UI run/text/tool/error events

AG-UI tool-result message
  -> Omnigent function_call_output
```

Provider-specific parsing must live in the gateway package, not the browser
package. Omnigent provisioning, health recovery, and opaque identifiers remain
unchanged.

## Security composition slice

Prove that AG-UI begins only after Agent Connect establishes an authorized
application session. The spike must preserve:

- gateway identity and runtime enrollment boundary;
- exact Origin and requester checks;
- app identity/key and requested scope binding;
- fixed/canonical tool-snapshot authorization;
- expiring, revocable session authority;
- the future authenticated encrypted channel boundary.

Do not encode pairing secrets, gateway private identity, raw provider ids, or
bearer credentials inside AG-UI messages or shared state.

## Validation cases

1. An official AG-UI browser client starts a run through the experimental
   gateway endpoint.
2. Codex receives and calls an unpredictable browser-defined nonce tool.
3. The browser returns the result and the same Codex turn incorporates it.
4. Text, tool-call, completion, failure, and cancellation events match the
   pinned AG-UI schemas.
5. Unknown tools, malformed arguments, duplicate action IDs, changed tool
   snapshots, wrong Origin, wrong requester, and expired grants fail closed.
6. Omnigent runner replacement remains hidden behind the logical application
   session.
7. A disconnect with a pending tool request has an explicit recovery outcome;
   missing AG-UI semantics must be recorded rather than papered over.
8. The existing custom endpoint continues to pass its regression suite.

Collect the browser network trace, gateway translation trace, Omnigent events,
and final Codex output. Redact credentials and personal identifiers.

## Adoption criteria

Recommend adoption only if:

- the official client interoperates without a project-specific AG-UI fork;
- frontend tools work through the live Omnigent/Codex composition;
- the security layer composes outside standard AG-UI event schemas;
- action correlation and recovery remain at least as strong as the baseline;
- the browser package becomes provider-neutral in implementation as well as in
  documentation;
- the required subset can be stated as a clear, versioned compatibility
  profile;
- implementation and dependency cost are justified by real interoperability.

Otherwise retain the current public API and provider contract, record the
specific incompatibility, and reconsider after the relevant protocol evolves.

## Non-goals

- replacing Omnigent's conductor or Codex orchestration;
- implementing every AG-UI capability;
- claiming that AG-UI supplies authentication or runtime ownership;
- removing ACP or `codex-acp` from the downstream path;
- rewriting the working demo before the spike passes;
- upstream standardization during the initial experiment.
