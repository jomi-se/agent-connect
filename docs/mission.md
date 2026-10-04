# Mission

**Connect your AI.** Choose the agent you already own, authorize an application,
and use it through the application's own interface. The application supplies
tools; your agent supplies intelligence under scoped, revocable consent.

Agent Connect lets applications lend a fixed, approved set of tools to a
user-owned agent. Applications own their UI, data and effects. The user chooses
the harness and model and keeps provider credentials in a dedicated harness
home. Application contracts stay agent- and harness-neutral.

The product is the ACP gateway (`agent-connect`) plus `@open-agent-connect/web`
at the package root. The SDK pairs through owner-hosted OAuth consent, connects
an ACP provider and supplies `createAcpChatTransport` for AI SDK `useChat`.
ACP is the chosen open standard for this product, established by
[ADR 0016](decisions/0016-acp-application-boundary.md), accepted on 2026-10-04.
ACP, MCP-over-ACP and the resume extension remain unstable as the standard and
its extensions evolve.

## Authority and reliability

Owner login, optional TOTP, exact-origin fixed-tool consent, rotating grants,
profile choice, session inspection/end-session and revocation live in the
gateway. Production sessions run in owned disposable boxes with dedicated
shared harness homes and restricted owned egress. Owner state stays outside
those homes. Per-app box isolation remains deferred; the accepted shared-home
risks are recorded in [the credential plan](plan/credentials.md).

Each conversation admits one active request. Persist application actions before
notifying the application. Stable action IDs require application-owned
idempotency or deduplication; generic exactly-once effects are not promised.
Transport reattachment and history recovery never replay uncertain prompts or
effects. Capacity is released only after owned resource cleanup succeeds.

## Evidence and scope

Routine gates exercise real pinned ACP adapters with deterministic inference,
isolated state and packaged artifact installation. Real-model app acceptance is
separate evidence. See [testing strategy](architecture/testing-strategy.md) and
[current owner gates](plan/current-work.md).

No generalized agent orchestration, arbitrary MCP features, Android automation,
second proprietary session protocol, production multi-tenancy or credential
migration is included. Start with [installation](install/README.md); architectural
and protocol changes need a decision record before implementation.
