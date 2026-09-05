# VAL-RUNTIME-001: Reuse real OpenClaw execution

Surface: api.
Needs: VAL-PAIR-001 and deterministic inference behind real OpenClaw.
Behavior: approved app uses its own session for multiple turns, native tool use
and client-defined function call/output; existing OpenClaw produces the Responses
JSON/SSE. No custom agent loop or generated replacement events. Tool capabilities
come from operator policy rather than a blanket deny-all product restriction.
Evidence: two-turn HTTP/SSE trace, native tool result and app tool round trip,
terminal event, actual native session identity. No real subscription charge.
Scope: one meaningful built-in tool proves composition, not all tools/harnesses.
