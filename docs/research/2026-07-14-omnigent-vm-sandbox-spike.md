# OmniGENT VM-local sandbox spike

Date: 2026-07-14

Versions tested: OmniGENT 0.5.1, `@agentclientprotocol/codex-acp` 1.1.2,
Codex 0.144.3, bubblewrap 0.9.0, Linux/aarch64.

## Outcome

The repository now generates a fail-closed OmniGENT `linux_bwrap` profile and
ships a guard wrapper. The outer process sandbox itself passed objective live
checks, but the complete dynamic application-tool loop did **not** pass inside
that sandbox. The profile is therefore experimental and must not be presented
as a working sandboxed demo until the MCP startup incompatibility below is
fixed.

## Implemented profile

`OmnigentRuntime` uploads an agent bundle that selects OmniGENT's
`linux_bwrap` backend, keeps the application workspace read-only, gives a
minimal dedicated Codex home write access, adds explicit project read mounts
for the pinned Codex ACP/vendor paths, and leaves network enabled because model
access and the OmniGENT relay need it. System paths and writable `/tmp` remain
visible. `scripts/omnigent-codex-sandbox-guard.sh` refuses to launch unless:

- a host sentinel outside every mounted root is invisible;
- the workspace rejects a write probe;
- `NoNewPrivs` is `1`;
- seccomp mode is `2`; and
- the dedicated Codex home is writable.

The guard pins the repository's Codex ACP and native Codex binary. It also
enables app-server diagnostics. The example OmniGENT configuration is
`config/omnigent-sandbox.yaml.example`.

## Live evidence

A live downstream Codex process was observed with:

```text
NoNewPrivs: 1
Seccomp: 2
demo-workspace mount: ro,nosuid,nodev
demo-codex-home mount: rw,nosuid,nodev
host sentinel: not visible (guard passed)
```

The minimal Codex home authenticated successfully without exposing the normal
Codex configuration or session tree. It does, however, contain the copied
`auth.json` needed by Codex. Because the agent runs in `agent-full-access` and
the outer sandbox shares the host network, a malicious prompt could read and
exfiltrate that credential. Writable `/tmp` also lets OmniGENT overlay its
temporary bridge path into the sandbox. The profile therefore does not yet
protect the user's Codex credential from an authorized malicious application;
this is a security blocker independent of the MCP startup failure.

## Compatibility failure

OmniGENT correctly received the request-scoped application tool and created a
per-session MCP relay under `/tmp/omnigent-<uid>/acp-mcp`. Codex app-server then
reported:

```text
MCP client for `omnigent` failed to start: MCP startup failed:
handshaking with MCP server failed: connection closed: initialize response
```

With Codex in its normal read-only mode, a diagnostic built-in command failed
more directly:

```text
bwrap: No permissions to create new namespace
```

This is expected from OmniGENT's hardened outer seccomp profile: it denies
`clone` calls carrying `CLONE_NEW*` and returns `ENOSYS` for `clone3`. Nested
Codex bubblewrap therefore cannot be the inner enforcement layer. Running
Codex in `agent-full-access` inside the effective outer boundary removes the
nested turn sandbox, but the OmniGENT MCP child still closed during its
initialize handshake in this environment. The same `serve-mcp` command and
bridge directory answered an MCP initialize request when run outside the live
Codex MCP launcher, establishing that tool-schema delivery and the relay itself
worked outside the boundary.

## 2026-07-15 source-level follow-up

The generated profile mounted the pinned Codex ACP and native Codex paths, the
dedicated Codex home, and writable `/tmp`, but did not mount OmniGENT's Python
installation under `/home/dev/.local/share/uv/tools/omnigent`. OmniGENT's ACP
bridge config tells Codex to start the relay with that installation's Python
and `-m omnigent.claude_native_bridge`. The runtime is therefore unavailable at
the path used by the MCP child inside the outer sandbox. This is now the leading
cause of the closed initialization handshake, separate from the confirmed
nested-Bubblewrap namespace denial.

The causal link still needs one controlled live test: add the OmniGENT runtime
as a read root, keep Codex in `agent-full-access`, capture the MCP child's
stderr, and repeat the dynamic-tool loop. The earlier diagnostic did not
capture that stderr because its zsh wrapper assigned to the reserved `status`
parameter and exited prematurely. Until the controlled rerun passes, describe
the missing mount as the leading diagnosis rather than a confirmed fix.

## Decision and next tests

Keep the fail-closed outer profile and honest diagnostics in the repository,
but use the already-passing unsandboxed OmniGENT demo path for the hackathon
until one of these closes the gap:

1. capture the MCP child stderr by wrapping or patching OmniGENT's generated
   ACP MCP command, then fix the exact launch incompatibility;
2. run the whole OmniGENT runner in a disposable container/VM boundary and
   avoid nested user-namespace sandboxing;
3. replace the downstream relay with a direct Codex app-server dynamic-tool
   adapter inside the outer sandbox; or
4. upstream a supported OmniGENT profile for ACP agents whose own tool/MCP
   processes need to spawn inside `linux_bwrap`.

Before this becomes a malicious-application profile, broker credentials outside
the tool-visible process or contain the entire runner behind controlled egress
and short-lived credentials. A copied long-lived login inside the agent-visible
home is not an acceptable production boundary.

No application-supplied parameter may disable the sandbox, add mounts, or
select the fallback. Runtime posture remains a gateway/operator choice.

The whole-runner option is now tracked as a broader
[containerized gateway deployment](../plan/containerized-gateway-deployment.md)
exploration, including a simple shared-container installation profile and a
stronger per-session runner-container target.
