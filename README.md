# Agent Connect

Lend an application's tools to the user's own agent. The application owns its
UI and effects; the user chooses the harness and model through their gateway.

**Unpublished candidates:** gateway 0.0.1 and browser SDK 0.0.10. Versions remain
on 0.0.x until the shape is final. ACP, MCP-over-ACP and resumable transport are
unstable under [proposed ADR 0016](docs/decisions/0016-acp-application-boundary.md).

## Install

Follow [the gateway install guide](docs/install/README.md). From a prepared
artifact set, install the gateway launcher and matching native platform package,
then run:

```sh
agent-connect setup
agent-connect doctor
```

Production sessions run in disposable boxes with a dedicated shared harness
home and owned restricted egress. Owner authentication/grants remain outside
the harness home. Read [the shared-home risks](docs/plan/credentials.md)
before owner-run login. Setup never imports personal credentials.

```text
Web app: @open-agent-connect/web + approved application tools
    | owner consent, exact origin, fixed tools, unstable ACP WebSocket
Agent Connect gateway: owner console, profiles, grants, session cleanup
    | pinned ACP adapter, owned egress
Disposable session box: dedicated harness home, user-selected agent/model
```

## Integrate

Import from `@open-agent-connect/web` at the package root. Pair using
`connectAgent`, then supply `createAcpChatTransport({ provider, tools })` to
AI SDK `useChat`. The harness owns its history and tool loop; the transport
validates and executes approved application tools internally. Applications
must deduplicate consequential effects with stable action IDs. Recovery never
replays uncertain prompts or actions.

See the [SDK API and React example](packages/web-sdk/README.md) and
[standalone packed sample](examples/acp-chat/README.md).

## Develop and validate

Use Node 24 LTS >=24.15 and <25, Docker and the pinned build/browser tools.
Prepare local artifacts using [the release checklist](docs/install/release.md).

```sh
npm install
npm run format:check
npm run typecheck
npm test
npm run build
cargo test --locked
npm run verify
```

Verification exercises real pinned ACP adapters with deterministic inference,
isolated state and artifact-only browser composition. Real-model application
acceptance is separate evidence. See [testing strategy](docs/architecture/testing-strategy.md).
Agents stage named paths and commit checked work; pushing and publication remain
owner-run actions. [Current work](docs/plan/current-work.md) records release gates.

## License

MIT
