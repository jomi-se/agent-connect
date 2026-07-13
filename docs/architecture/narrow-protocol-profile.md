# Narrow hackathon protocol profile

This profile intentionally implements an unstable subset. It is not a claim of full ACP or MCP-over-ACP conformance.

## Topology

- one authenticated WebSocket;
- one ACP client and conductor connection;
- one agent session;
- one `McpServerAcp` supplied by the application;
- one active MCP connection for that server;
- a fixed tool set for the session lifetime.

## ACP methods in the first end-to-end slice

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/update`
- `session/request_permission`
- `mcp/connect`
- `mcp/message`
- `mcp/disconnect`

## Nested MCP methods

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

Resources, prompts, logging, completion, sampling, elicitation, subscriptions, pagination, and multiple logical servers are deferred.

## Reconnect boundary

ACP v1 session loading does not replay in-flight transport requests. The conductor therefore persists application tool requests before dispatch. Reconnection creates a fresh physical ACP transport, loads the agent session, establishes a new MCP connection, and redispatches or lists the unresolved action with the same stable action ID.

## Error behavior

The web SDK rejects:

- unknown server IDs on `mcp/connect`;
- a second active logical connection;
- unknown or closed connection IDs;
- MCP messages before initialization where initialization is required;
- unsupported MCP methods;
- malformed or unknown tool calls.

Errors must be machine-readable and must not silently fall back to executing a different tool.
