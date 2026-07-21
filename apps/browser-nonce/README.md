# Browser nonce demo

This ordinary Vite application imports `@agent-connect/web`, binds its neutral
`AgentSession` API to an already-online Omnigent session, and lends one
request-scoped browser tool. The page passes only when Codex calls that tool
once and the same turn includes the browser-generated nonce.

With the isolated Omnigent server and host running, provision a session:

```sh
UV_CACHE_DIR="$PWD/.omnigent-spike/uv-cache" \
  uv run --python 3.12 --with omnigent-client==0.5.1 \
  python apps/browser-nonce/provision.py \
  --base-url http://127.0.0.1:PORT
```

Then start the Vite app, pointing its same-origin development proxy at the
printed Omnigent URL:

```sh
OMNIGENT_URL=http://127.0.0.1:PORT npm run dev \
  --workspace @agent-connect/browser-nonce
```

Open the printed Vite URL with `?session=SESSION_ID`. The proxy is development
scaffolding, not the production pairing/security design.
