# Future feature: migrate Firebase Canvas to the stock plugin

Status: implementation in progress. Product intent captured 2026-09-09;
workbench, deterministic scenarios, and address-based OAuth entry implemented
2026-09-17.

## Goal

Turn the historical Firebase Canvas into both a polished public demonstration
and a readable reference application for the supported Agent Connect setup. It
must no longer teach runtime cards, a separately operated proxy, or retired
enrollment commands.

Keep the three existing scenarios—project board, document review, and
shopping—because together they show the same bounded application-tool flow
across meaningfully different interfaces.

## Two honest entry paths

The landing experience offers two equally clear actions:

- **Try the demo** runs a deterministic client-side simulation. It performs no
  OAuth transaction, calls no hosted inference service, and is labeled wherever
  a visitor could mistake simulated behavior for a live agent. It is product
  illustration, not protocol compatibility evidence.
- **Connect your agent** accepts the visitor's compatible Agent Connect HTTPS
  address, uses the published Web SDK and normal OAuth consent, and spends only
  the visitor's own configured provider allowance. Operator infrastructure is a
  private reference deployment and must not be offered as a public inference
  backend.

The simulated and real paths should share presentation components where useful,
but the real integration must remain easy for a developer to locate and read.

## Migration behavior

The first implemented slice removes the runtime-card surface, adds the two
honest entry paths, runs all three deterministic scenarios through the real
page-owned tool handlers, and starts the current stock-plugin OAuth flow from a
compatible HTTPS address. Controlled live-plugin composition and the full
conversation/recovery matrix below remain acceptance work rather than claims
of this slice.

- Replace runtime-card parsing, storage, paste UI, setup animation, and legacy
  environment instructions with the current address-based connection contract.
- Use current `gateway` terminology in visible copy. Retain `connector*` only
  where an internal compatibility name still requires it.
- Exercise authorization, profile selection, application-tool execution,
  independent conversations, a continuation turn, reload of a still-valid
  conversation, starting a new conversation, disconnect, and grant revocation.
- Present expired authorization, unavailable history, changed gateway address,
  cancellation, timeout, and unreachable gateway as explicit recovery states.
- Update deployment and reference documentation so the published Canvas and its
  source describe the same supported flow.

After the migrated Canvas and its tests no longer import legacy runtime-card or
standalone-gateway surfaces, inventory those consumers before removing the old
implementation. Migration is the prerequisite for cleanup, not evidence that
all shared legacy modules can be deleted at once.

## Acceptance outcomes

- A visitor without a gateway can understand the complete product loop without
  creating an account or consuming inference.
- A visitor with a compatible endpoint can complete the real OAuth and tool
  flow without pasting a runtime card or following retired setup instructions.
- The browser suite covers all three scenarios in deterministic demo mode and a
  focused current-SDK integration flow against a controlled real stock plugin.
- The reference example does not embed credentials, a private operator address,
  or a publicly funded model endpoint.
