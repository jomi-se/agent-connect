# Gateway troubleshooting (ACP prerelease)

Start with `agent-connect doctor`, `agent-connect service status` and
`agent-connect service logs --lines 100`. Use `--config <config>` with doctor or
before the service operation for a non-default runtime. These operations do not
perform provider login or modify personal credentials. Do not paste grants,
cookies, passphrase files or harness credentials into bug reports.

## Doctor codes

`agent-connect doctor --json` emits an object with `ok` and `checks`. Each check
has a stable `code`, a `status` of `pass`, `warn` or `fail`, a human `message`
and an optional `fix`. Exit 1 means a failed check needs repair; warnings can
coexist with exit 0. A warning about login or reachability still needs attention
before first use. Doctor inspects configuration and file metadata, never provider
credential contents or owner authentication secrets.

| Code                  | Meaning and next action                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config_valid`        | Config is missing, invalid or unsafe. Run setup for a fresh runtime, or repair the existing private config without replacing owner state.                                                                |
| `runtime_permissions` | Runtime/state directories must be owned by the invoking user, private (0700), and not symlinks. Use the account that created them.                                                                       |
| `owner_state`         | Owner-state file must exist and be private (0600). Restore its protected backup or deliberately start a new runtime and pair again. Headless mode reports a warning because it has no hosted owner flow. |
| `docker_available`    | Start Docker and ensure `docker info` works as the gateway user. Running the gateway as root is not the repair.                                                                                          |
| `box_image`           | Run setup to build the local box from the installed npm package. A build failure is not a login failure.                                                                                                 |
| `egress_owned_ready`  | The configured owned proxy must be running and match the image. Rerun setup for this runtime. A conflicting/foreign container is never replaced automatically.                                           |
| `harness_home`        | The dedicated home is missing or unsafe. Keep it private and separate from owner state; do not substitute a personal harness home.                                                                       |
| `login_file_present`  | Credential-file metadata is present. This does not verify the credential, subscription or provider response.                                                                                             |
| `login_required`      | Run `agent-connect login --config <config>` yourself. No live login check was attempted. A provider credential store may need owner verification.                                                        |
| `listener_port`       | A running gateway can occupy its own port. Check status and health; avoid starting a foreground gateway beside the service.                                                                              |
| `clock`               | TLS, OAuth and TOTP require accurate time. Enable operating-system network time synchronization. This check only verifies a plausible date.                                                              |
| `public_reachable`    | Check service, DNS, TLS trust and the HTTPS reverse proxy. Forward `/healthz`, owner/OAuth, metadata and WebSocket routes; do not disable TLS verification.                                              |

`/healthz` is credential-free HTTP readiness. HTTP success is not evidence of
provider authentication or an end-to-end application turn. Check the owner
Activity page's runtime banner and verify a sample tool call after provider login.

## Setup or service stopped halfway

Rerun setup with the same directory and origin. It preserves an existing private
runtime, resumes dependencies and refuses conflicting configuration. Do not
delete state to bypass a setup error: that loses owner identity, grants and
action journals. If a user service manager is unavailable, use `setup --no-service`
and run `serve --config <config>` under your chosen supervisor. Linux requires a
running systemd user manager; macOS service operation requires a launchd user
session. Windows is unsupported.

The service definition is owned by a specific runtime. Operations refuse foreign
or conflicting definitions. Use `setup --upgrade` after installing a new binary:
it replaces the owned service executable and restarts the service while preserving
the private runtime and harness home, even when the box is unchanged.
Service logs are bounded
recent output, rather than a continuous follow stream.

## Pairing or connection failed

Use the exact app origin: `localhost` and `127.0.0.1` are different origins, as
are HTTP/HTTPS and different ports. Pair with the exact configured gateway entry
point the app will use; its issuer and grant are bound to that origin. For remote use, compare your proxy with the
[Caddy/nginx examples](configuration.md#https-reverse-proxy); preserve Origin and
WebSocket subprotocol headers and never inject bearer credentials.

| WebSocket close  | What to do                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| 4401, 4414       | Invalid, expired or revoked app grant: explicitly Connect for new consent.                           |
| 4403             | Match the approved application origin.                                                               |
| 4404, 4410, 4413 | Session expired: recover deliberately, preserving the transcript and avoiding uncertain turn replay. |
| 4409, 4415       | Another attachment owns the session: use that attachment or start a new session explicitly.          |
| 4418             | Wait for capacity, end an unused live session in Activity, or investigate failed cleanup.            |
| 4500             | Check service logs and doctor for adapter/container launch failures.                                 |
| 1009             | Reduce the serialized frame below 1 MiB; this terminal failure must not be retried unchanged.        |

Stopping or losing a turn does not undo completed tools. Never automatically
resend prompts or uncertain tool results. Gateway restart loses process-local
ownership and resumable transport handles; saved provider transcripts do not
restore them. See the [SDK error and recovery contract](../../packages/web-sdk/README.md).

## Read-only native command fails to start

`bwrap: No permissions to create a new namespace` means the host blocked Codex's
nested sandbox before the command ran. Native operations fail closed; approved
application tools can still work. Keep the container security settings intact.
Choose the documented sandboxed profile only if its wider native authority is
acceptable, or use a host that supports the harness sandbox. This failure is not
evidence that a write reached the filesystem and was rejected by read-only policy.

## Lost authenticator

Recovery is a local owner operation, unavailable through a web recovery endpoint:

```sh
agent-connect service stop
agent-connect reset-totp --config <config> --yes
agent-connect service start
```

For a non-default runtime, pass the same config to both service commands.
`--yes` explicitly confirms the local reset. `reset-totp` requires the private authorization state to be owned by the invoking
user and refuses to proceed while the gateway holds its exclusive state lock.
It clears the enrolled factor and its replay counter while preserving the owner
passphrase and application grants. It records recovery count/time without
printing any secret. Sign in with the existing passphrase and set up a new
authenticator from Security. Recovery does not grant access to a lost owner passphrase or
authenticate the provider.

## Lost passphrase

Replace it locally at a terminal; the gateway keeps no copy to recover:

```sh
agent-connect service stop
agent-connect reset-passphrase --config <config>
agent-connect service start
```

It prompts twice for the new passphrase and refuses to proceed while the gateway
holds its state lock. The authenticator and application grants are preserved.

## Docker cleanup and capacity

Capacity is released only after the owned session container and network are
removed. Bounded cleanup failure keeps its slot reserved until operator cleanup
and process restart; a restart alone does not delete resources from an earlier
process. Stop active turns, allow graceful shutdown and use service diagnostics
to identify the failed session. Remove only its identified owned resources;
retain shared egress and model peers. Never use a broad Docker prune or remove
another application's resources. Retrying the interrupted prompt can duplicate
an application effect and is not cleanup.

For unsupported or disputed provider authentication, consult the
[credential and terms analysis](../plan/credentials.md). ACP setup creates fresh grants and never imports personal provider login state.
