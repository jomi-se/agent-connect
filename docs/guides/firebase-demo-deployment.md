# Deploy the Firebase Canvas

The Canvas is a static Firebase Hosting application. Visitors can run its
deterministic local demo without an account, or connect their own configured
Agent Connect stock OpenClaw plugin over HTTPS. Firebase never hosts inference,
the gateway, or an application grant.

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

## Connect a gateway

Configure the stock plugin using the
[OpenClaw setup guide](../../deploy/openclaw-gateway/README.md), and give the
Canvas the browser-reachable HTTPS address for its Agent Connect gateway. A bare
Origin is accepted and normalized to the plugin's `/agent-connect` provider
base. The gateway's allowed application Origins must include the exact Firebase
Hosting Origin.

The Canvas discovers OAuth metadata at that address and redirects the browser
to the gateway-owned owner sign-in and consent flow. It stores the resulting
delegated connection only in the tab's `sessionStorage`. **Disconnect & revoke
access** revokes refresh authority at the gateway before clearing that browser
copy.

Do not expose native OpenClaw's owner listener as though it were the application
gateway. The plugin owns a separate bounded listener and the public
`/agent-connect` routes.

## Credential boundary

- The Firebase service account exists only as an encrypted GitHub Actions
  secret and is not copied to the gateway VM or built page.
- The enrollment passphrase is entered only on the gateway Origin. It must
  not appear in Firebase configuration, application storage, URLs, logs, or
  source control.
- The delegated grant is revocable and bound to the exact application Origin,
  redirect, app id, scopes, and approved tool snapshot.
- OpenClaw credentials and provider allowance remain on the user's host. The
  Canvas receives neither.
