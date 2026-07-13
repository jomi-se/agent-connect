# Dedicated Firebase demo setup

The Firebase deployment credential does not need to exist on the agent VM. A
manual GitHub Actions workflow builds and deploys the static Canvas demo.

## One-time account setup

1. In the Firebase console, create a dedicated project on the Spark plan. A
   descriptive ID such as `agent-connect-demo-USERNAME` is useful. Do not enable
   Firestore, Authentication, Functions, Analytics, or billing; this demo uses
   Hosting only.
2. Enable Firebase Hosting for the project. The stable application origin will
   be `https://PROJECT_ID.web.app`.
3. Create the Hosting deployment service account using Firebase's documented
   `firebase init hosting:github` flow on a credentialed computer, or create a
   narrowly scoped account manually. Do not copy its JSON key to this VM.
4. In `jomi-se/agent-connect` GitHub repository settings, create:
   - Actions variable `FIREBASE_PROJECT_ID_AGENT_CONNECT_DEMO` containing the
     project ID;
   - Actions secret `FIREBASE_SERVICE_ACCOUNT_AGENT_CONNECT_DEMO` containing the
     complete service account JSON.
5. Run the `Deploy Firebase demo` workflow manually. It deploys only when
   explicitly dispatched and writes to the dedicated project's live Hosting
   channel.

## Connect it to the VM

Use the stable Firebase origin in the gateway configuration:

```sh
export AGENT_CONNECT_ALLOWED_ORIGINS='https://PROJECT_ID.web.app'
export AGENT_CONNECT_ALLOWED_TAILSCALE_USERS='YOUR_TAILSCALE_LOGIN'
export AGENT_CONNECT_ACCESS_TOKEN='OPTIONAL_LONG_RANDOM_SECRET'
npm run start --workspace @agent-connect/gateway
```

Then expose the loopback gateway without replacing the VM's existing port 443
Serve mapping:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

Open `https://PROJECT_ID.web.app` from a Tailscale-connected browser, enter the
OmniGENT session ID and optional runtime access token, and ask Codex to write a
message. The page supplies `set_page_message` dynamically and should update its
large visible canvas text during the same task.

## Credential boundary

The Firebase service account exists only as an encrypted GitHub Actions secret.
The hosted page contains no Firebase SDK configuration and no deployment
credential. The optional Agent Connect bearer token is entered by the user and
stored only in browser `sessionStorage` for this personal demo.
