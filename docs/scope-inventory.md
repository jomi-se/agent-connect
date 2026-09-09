# Scope and capability inventory

Updated: 2026-09-09

This inventory describes the supported stock OpenClaw plugin selected by
[ADR 0015](decisions/0015-openclaw-plugin-host.md). The superseded standalone
proxy is archived in git history and is not built, tested, or deployed from
`main`.

## Application and SDK

| Capability                                  | Status                      | Current boundary                                                                                |
| ------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| Define typed application tools              | Implemented                 | Browser-safe definitions; exact owner-approved snapshot on every segment                        |
| Discover and authorize a gateway            | Implemented                 | Plugin issuer, PAR, S256 PKCE, consent, rotating refresh and revocation                         |
| Establish owner identity                    | Implemented                 | Enrollment secret creates a hashed secure owner session; tailnet headers are not owner identity |
| Use Open Responses and AI SDK               | Implemented bounded profile | Text, approved application functions, streaming/nonstreaming, and explicit continuation         |
| Refresh without losing a conversation       | Implemented                 | Access-token rotation preserves the grant authorization version                                 |
| Read/reopen recent execution heads          | Implemented, process-local  | Same active grant only; bounded projection; inputs do not claim human authorship                |
| Continue after restart or ambiguity         | Explicitly unavailable      | Process-local ownership is lost and possibly admitted work is never replayed                    |
| Generic exactly-once effects                | Explicit non-goal           | Applications own idempotency and deduplication                                                  |
| Media, arbitrary history or background jobs | Rejected                    | Version-zero request profile is text-only with a bounded recent execution view                  |

## Plugin and OpenClaw

| Capability                               | Status                                   | Current boundary                                                                         |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Install into published stock OpenClaw    | Implemented and deterministically tested | Exact host version/integrity and the packed public plugin tarball                        |
| Keep operator credentials private        | Implemented                              | Resolved inside the host; never becomes application authority                            |
| Prevent caller routing escalation        | Implemented                              | Agent, model, session and protected headers are server-owned; unknown fields fail closed |
| Bind response IDs to authority           | Implemented                              | Grant version, policy fingerprint, agent, tool hash and private conversation are checked |
| Bound continuation state                 | Implemented                              | One current mapping, 30-minute TTL, 1,024 total and eight per grant by default           |
| Stop unapproved function publication     | Implemented                              | Function items are checked before their first event is published                         |
| Enforce restricted application agent     | Configured and stock-tested              | No native tools, bootstrap, context injection, skills, memory, tool search, or elevation |
| Preserve personal OpenClaw configuration | Implemented                              | Setup adds only namespaced Agent Connect state and refuses conflicts                     |
| Handle subscription credentials          | OpenClaw-owned                           | Agent Connect neither stores nor exposes provider credentials                            |

## Remaining evidence gates

The deterministic suite does not prove subscription inference, real HTTPS
ingress, arbitrary third-party plugin coexistence, or every Bookhand behavior.
Those remain separate owner-reviewed evidence. Upstream effects after admission
may be ambiguous; no automatic retry or generic exactly-once claim is made.
