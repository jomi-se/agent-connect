# Reader chat sample (unstable ACP alpha)

Requires Node 24 LTS >=24.15 and <25. This standalone Vite application consumes
the public `@open-agent-connect/web/acp` export. It has no repository aliases.
ACP, MCP-over-ACP and the resume extension remain experimental.

Install the release SDK tarball, then build or start the application:

```sh
npm install /path/to/open-agent-connect-web-0.1.0-alpha.1.tgz
npm run dev
```

Install the gateway and the platform binary from the same release. With Docker
and the release session image available, prepare a dedicated operator directory:

```sh
agent-connect-gateway init --directory ./runtime --harness codex \
  --allow-origin http://127.0.0.1:5173 --tools ./tools.json
agent-connect-gateway login --harness codex --harness-home "$PWD/runtime/home"
agent-connect-gateway egress start
agent-connect-gateway serve --config ./runtime/config.json
```

The operator reviews `tools.json`, then supplies `runtime/grant.json`
using the grant upload control, or enters the gateway URL and token in the form.
Check the approval box and connect. The grant stays in memory; the sample never
puts it in a URL or browser storage. Use HTTPS/WSS when hosting remotely.

Ask the agent to read chapter 1 and highlight a phrase. The three fixed tools
read a passage, mark exact text, and ask a question which waits for your answer.
Stop cancels the active turn, including an unanswered reader question. Reloading
the page requires a deliberate new connection; it does not replay a prompt.
After cancellation or a terminal failure, choose **New connection** to send a
new message with the same in-memory grant and approved tools. Previous messages
stay visible but are never sent to the new harness session. Reloading still
requires uploading the grant again.
If the gateway reports full session capacity while the old box closes, wait
a moment and choose **New connection** again. No message is sent until you
submit it yourself.

For deterministic clean-room testing, the scripted model recognizes
`SPIKE-TOOLS`, `SPIKE-ASK`, and `SPIKE-SLOW`. These prompts are test-fixture
commands, not required by a real agent.
