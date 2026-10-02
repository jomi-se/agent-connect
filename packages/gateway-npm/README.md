# Agent Connect gateway launcher

**Unreleased dry run. ACP and MCP-over-ACP are unstable.** This workspace is
private until release approval. It pins both adapters and the unmodified harness
CLIs. It selects one platform package through optional dependencies; it never
downloads an executable during launch. The current OpenClaw plugin stays intact.

Supported artifact targets: Apple Silicon, Linux x64 musl, Linux ARM64 musl.
Windows remains pending. The gateway and session image share version 0.1.0.
`AGENT_CONNECT_GATEWAY_BIN` selects a local binary for testing. It is an explicit
operator option, never an application input. Normal installations require the
matching platform artifact; no artifacts have been published.
