# Stock OpenClaw Agent Connect setup

The supported provider is the published Agent Connect plugin hosted by the
user's stock OpenClaw gateway. Users do not operate a separate Agent Connect
proxy process. See [ADR 0015](../../docs/decisions/0015-openclaw-plugin-host.md)
and the [implementation contract](../../docs/architecture/stock-openclaw-plugin.md).

Use Node 24 LTS >=24.15 and <25 with stock OpenClaw 2026.9.1. Install the
reviewed public package through OpenClaw's managed plugin path and explicitly
accept its declared host capabilities:

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@0.0.1 --pin --accept-capabilities
```

Operational installs must use the published package. `npm-pack:` is reserved
for isolated repository compatibility tests; do not use a checkout, `npm link`,
or a local tarball for deployment.

On an interactive terminal, use the guided setup:

```sh
openclaw agent-connect setup
```

It reuses valid current configuration, asks only for missing public-origin and
restricted-model choices, shows one summary, and requires confirmation before
writing. Existing scripts retain explicit preview/apply behavior:

```sh
openclaw agent-connect setup --origin https://your-gateway.example
openclaw agent-connect setup --origin https://your-gateway.example --apply --non-interactive
```

Save the one-time enrollment passphrase shown by the first successful apply in
the owner's password manager. It is not stored in plaintext or printed again.
Setup adds the namespaced restricted agent, the plugin configuration, and native
Responses enablement while preserving unrelated personal configuration.
Conflicts fail instead of being overwritten.

Restart the gateway explicitly, then inspect readiness:

```sh
openclaw agent-connect doctor
curl https://your-gateway.example/agent-connect/healthz
```

`doctor` reports `ready`, `setup_required`, `owner_identity_missing`, or
`unsupported_host` and exits nonzero unless it is ready. Configured OpenClaw
token, password, and explicit no-auth modes are supported. No-auth mode warns
because native endpoints outside `/agent-connect` are not protected by
application grants. Native listener TLS remains unsupported; terminate public
HTTPS outside the loopback listener.

Applications discover the provider at
`https://your-gateway.example/agent-connect`. The public application API never
receives an OpenClaw operator credential or private session identifier.

Disabling the plugin removes its hosted routes and aborts plugin-owned work
without deleting personal configuration or plugin state:

```sh
openclaw plugins disable agent-connect
openclaw plugins enable agent-connect --accept-capabilities
openclaw agent-connect doctor
```

The exact supported configuration matrix and trusted-operator reload limitation
are documented in the implementation contract. Build and verification do not
change a live gateway, Tailscale route, credential, or subscription runtime.
