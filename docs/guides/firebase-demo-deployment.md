# Deploy the Firebase Canvas

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

The hosted app is independent of the runtime profile. Paste a runtime card from
a real gateway created with the
[real gateway guide](../../deploy/real-gateway/README.md). The app verifies
the gateway key, redirects to gateway-owned authorization, and stores the
resulting app grant only in the tab's `sessionStorage`.

For the real Tailscale Serve profile, publish only the loopback gateway and
make the configured public endpoint match the selected HTTPS Serve port
exactly. Follow the current real-gateway guide rather than copying ports from
historical spike notes.

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
