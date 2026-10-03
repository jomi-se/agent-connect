# Scope inventory

The product consists of the Rust ACP gateway, npm gateway launcher/platform
packages, boxed session image, root browser SDK and standalone ACP chat sample.
SDK 0.0.10 and gateway/image 0.0.1 are unpublished candidates with independent
versions. Formal ADR acceptance and publication remain owner gates.

Current capabilities include owner pairing/consent, fixed tools, profiles,
app-tool execution, AI SDK chat, session ownership, cancellation, sequence
reattachment, explicit history recovery, revocation and owned cleanup. ACP,
MCP-over-ACP and the resume extension are unstable. Per-app isolation and Windows
support remain deferred. See [current work](plan/current-work.md),
[architecture](architecture/target-architecture.md) and [install](install/README.md).
