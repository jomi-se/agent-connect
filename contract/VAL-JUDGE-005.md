# VAL-JUDGE-005: Container policy reduces direct runner blast radius

Surface: runtime and operator.
Needs: the Compose judge stack and VAL-JUDGE-004.
Behavior: gateway, OmniGENT server, and OmniGENT host/agent run as separate
non-root containers with read-only root filesystems, default seccomp, all
capabilities dropped, no-new-privileges, resource bounds, isolated persistent
volumes, and disposable runner tmpfs. The runner cannot directly reach the
gateway or Internet and receives no host namespace, sensitive mount, or
connector-state volume. Prompts requesting shell, filesystem, credential, or
network activity still produce only the fixed browser tool call.
Evidence: Compose config and `docker inspect`, effective UID/capability/mount/
network probes, host-sentinel and Docker-socket absence, failed external DNS/TCP
probe, allowed OmniGENT-server connectivity, denied runner listening ports and
lateral network paths, a hostile runtime probe under the exact runner policy,
process/transcript inspection, and workspace replacement after restart.

Fail: any service is privileged or runs as root, the runner reaches
the Internet/gateway or sees a sensitive host path/volume, or a prompt changes
the spawned command/tool behavior.
Scope: this is defense in depth against application and dependency compromise,
not proof of arbitrary-RCE containment. The request-scoped MCP relay runs inside
the host container and uses OmniGENT's server-mediated protocol path. The runner
can reach the OmniGENT server, which bridges to the gateway network; a chained
server compromise is a residual pivot path. Kernel/container-runtime escape and
a malicious host admin are also outside the claimed boundary.
