# Internal gateway components

The supported user-operated gateway is the
[stock OpenClaw plugin](../openclaw-plugin/README.md). Users do not run a
separate Agent Connect proxy process.

This private workspace package currently supplies shared authorization, grant,
OAuth and tool-snapshot components consumed by the plugin. It also still
contains the historical replacement-engine binary and compatibility code. That
older engine is not part of the supported installation, release or deployment
path; retiring it is a separate cleanup decision.

For installation and operation, use the
[plugin gateway guide](../../deploy/openclaw-gateway/README.md).
