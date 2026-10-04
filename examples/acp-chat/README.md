# Reader chat sample (experimental ACP)

Requires Node 24 LTS >=24.15 and <25. This standalone Vite application consumes
the public `@open-agent-connect/web` export. It has no repository aliases.
ACP, MCP-over-ACP and the resume extension remain experimental.

Install the release SDK tarball, then build or start the application:

```sh
npm install /path/to/open-agent-connect-web-0.0.10.tgz
npm run dev
```

Install and set up the matching gateway using the
[install guide](../../docs/install/README.md). Provider login is an owner-run
step in a dedicated harness home. For a supplied local candidate, use its
matching platform tarball and session image. Normal setup starts the user service.

Enter the gateway's HTTP or HTTPS address and choose **Connect**. The gateway's
owner sign-in and consent pages show the application origin and its exact three
tools. Approve there, choosing the grant duration; an enabled owner TOTP factor
is also required there. The application receives its scoped grant through a
PKCE callback. There is no grant file upload or token entry. Desktop consent
opens a popup; touch devices use a redirect back to this application. Use
HTTPS/WSS when hosting remotely.

The SDK keeps the managed grant in this tab's session storage and rotates its
refresh token when needed. Reloading restores authorization, without replaying
a message or restoring a previous harness conversation. Other tabs need their
own approval. The gateway owner can inspect and revoke grants on the gateway's
owner pages. Revocation clears this application's stored authorization and
shows an explicit approval-ended error; choose **Connect** to request a new
approval. A rejected or expired grant never opens consent automatically.

Ask the agent to read chapter 1 and highlight a phrase. The three fixed tools
read a passage, mark exact text, and ask a question which waits for your answer.
Stop cancels the active turn, including an unanswered reader question. After
cancellation or a recoverable adapter exit, the application restores the same
conversation without repeating the interrupted prompt or tool result. Wait for
the restored notice before deliberately sending another message. If recovery
fails, choose **Retry recovery**. Owner-ended or superseded conversations require
**New connection** instead. Previous messages stay visible and are never replayed.

A real browser back/forward-cache restoration keeps the same chat, grant and
pending tool answer. The page's cleanup handler preserves these when
`pagehide.persisted` is true; ordinary departure closes its connection. If the
gateway reports full session capacity while the old box closes, wait a moment
and choose **New connection** again. No message is sent until you submit it.

For deterministic clean-room testing, the scripted model recognizes
`SPIKE-TOOLS`, `SPIKE-ASK`, and `SPIKE-SLOW`. These prompts are test-fixture
commands, not required by a real agent.
