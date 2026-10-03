# Scope and capability inventory

Updated: 2026-10-03

The ACP artifact install path is implemented as an unpublished
`0.1.0-alpha.1` candidate under proposed ADR 0016. The previous OpenClaw plugin
selected by ADR 0015 remains in the repository and on npm. Its older standalone
predecessors remain archival; they are distinct from the new ACP gateway.

## ACP candidate

| Capability                                  | Status                                          | Evidence / boundary                                                                                   |
| ------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Artifact installation without a checkout    | Locally verified                                | Packed gateway/SDK, standalone sample, fresh container                                                |
| Grant and exact tool consent                | Implemented                                     | Hosted owner consent, S256 PKCE, fixed full tools, rotating grants and revocation                     |
| Boxed harness execution                     | Real-adapter deterministic gates                | Pinned CLIs/adapters, private egress, dedicated whole home                                            |
| Chat/app tools/useChat                      | Implemented and tested                          | Browser tool effects, thoughts, cancel; no second app-side harness loop                               |
| Resume and session/load recovery            | Implemented and tested                          | Same transport reattach; interrupted turns never re-sent; process-local ownership                     |
| Native plan UI mapping                      | Contract-tested only                            | Pinned fixture configurations advertise no native plan tool                                           |
| Live subscription credential refresh/revoke | Owner-run, unverified                           | Dedicated helper prepared; personal logins untouched                                                  |
| Releases                                    | Automation locally validated, unpublished       | OIDC/provenance, immutable image digest, owner tag/approval gates                                     |
| Platforms                                   | Apple Silicon + Linux x64/ARM64 artifact matrix | Both Linux archives built locally; macOS exercised by first real native workflow; Windows unsupported |

## Previous OpenClaw capabilities

The following sections retain the previous plugin's evidence and guarantees;
they do not establish ACP-specific isolation or cross-restart recovery.

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
| Install into published OpenClaw package  | Implemented and deterministically tested | Exact host version/integrity and the packed public plugin tarball                        |
| Keep operator credentials private        | Implemented                              | Resolved inside the host; never becomes application authority                            |
| Prevent caller routing escalation        | Implemented                              | Agent, model, session and protected headers are server-owned; unknown fields fail closed |
| Bind response IDs to authority           | Implemented                              | Grant version, policy fingerprint, agent, tool hash and private conversation are checked |
| Bound continuation state                 | Implemented                              | One current mapping, 30-minute TTL, 1,024 total and eight per grant by default           |
| Stop unapproved function publication     | Implemented                              | Function items are checked before their first event is published                         |
| Enforce restricted application agent     | Configured and OpenClaw-tested           | No native tools, bootstrap, context injection, skills, memory, tool search, or elevation |
| Preserve personal OpenClaw configuration | Implemented                              | Setup adds only namespaced Agent Connect state and refuses conflicts                     |
| Handle subscription credentials          | OpenClaw-owned                           | Agent Connect neither stores nor exposes provider credentials                            |

## Remaining evidence gates

The deterministic suite does not prove subscription inference, real HTTPS
ingress, arbitrary third-party plugin coexistence, or every Bookhand behavior.
Those remain separate owner-reviewed evidence. the owner's 2026-09-09 report that the
complete Bookhand vertical slice works is live owner evidence, not an exhaustive
independent edge-case certificate. Upstream effects after admission may be
ambiguous; no automatic retry or generic exactly-once claim is made.
