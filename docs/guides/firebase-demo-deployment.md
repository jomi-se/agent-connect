# Deploy the historical Firebase Canvas

Status: maintained for the published Build Week/runtime-card demo. This guide
does not install or configure the current stock OpenClaw plugin; use the
[stock OpenClaw setup guide](../../deploy/openclaw-gateway/README.md) for that
path.

The Canvas is a static Firebase Hosting application. Its deployment credential
does not need to exist on the gateway host.

## One-time Firebase and GitHub setup

1. Create a dedicated Firebase project. Hosting is the only Firebase product
   required; the application does not need Authentication, Firestore,
   Functions, Analytics, or billing.
2. Enable Hosting. The stable application Origin is
   `https://PROJECT_ID.web.app`.
3. Create the Hosting deployment service account using Firebase's documented
   GitHub integration on a credentialed machine, or create an equivalently
   narrow service account manually.
4. Add these repository settings:
   - Actions variable `FIREBASE_PROJECT_ID_AGENT_CONNECT_DEMO` with the project
     id;
   - Actions secret `FIREBASE_SERVICE_ACCOUNT_AGENT_CONNECT_DEMO` with the
     complete service-account JSON.
5. Run the `Deploy Firebase demo` workflow manually. It builds and deploys only
   the Canvas workspace to the live Hosting channel.

## Connect a runtime

The hosted app is independent of the runtime profile. This preserved demo
expects a runtime card from an already configured legacy gateway. The current
[stock OpenClaw plugin](../../deploy/openclaw-gateway/README.md) uses a
path-bound provider URL instead and does not emit runtime cards, so do not use
that guide to operate this Canvas. Migration of the Canvas is tracked in
[current work](../plan/current-work.md).

With the legacy runtime available, paste its runtime card. The app verifies the
gateway key, redirects to gateway-owned authorization, and stores the resulting
app grant only in the tab's `sessionStorage`.

For a legacy Tailscale Serve profile, expose only that legacy loopback gateway
and make its configured public endpoint match the selected HTTPS Serve port.
The current plugin listener is not a drop-in replacement for that runtime-card
endpoint. Do not forward native OpenClaw's listener to make this demo connect.

## Credential boundary

- The Firebase service account exists only as an encrypted GitHub Actions
  secret and is not copied to the gateway VM or built page.
- The enrollment passphrase is entered only on the gateway Origin. It must
  not appear in Firebase configuration, application storage, URLs, logs, or
  source control.
- The runtime card is public identity and routing material, not an app grant or
  model credential.
- The app grant is revocable and bound to the exact Origin, redirect, app id,
  scopes, and tool snapshot.
