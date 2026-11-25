# Each app sees only its own conversations

Status: needs-triage. The MCP-over-ACP binding migration it waited for
shipped in gateway 0.0.7 (90f550b).

Every session mounts the same dedicated harness home, which holds the login,
the harness configuration and every conversation's history. An approved app
writes the prompts, so it can ask the agent to read the history files and see
what other apps' sessions said. The approval page says so today: "An approved
app can use your agent's login and see other apps' conversations."

The goal: an approved app can use the agent and its login, and nothing of
another app's sessions.

## Direction

Each app (grant) gets its own home for history and configuration; only the
login is shared, so the dedicated login keeps one refresh chain
([credentials](credentials.md)). The hard part is sharing one file between
homes: both harnesses rewrite their credential file when they refresh it, and
a rename over a bind-mounted single file fails. Options to try per harness:
mount a directory that holds only the credential, point the harness at it
(`CODEX_HOME`, `CLAUDE_CONFIG_DIR` and their credential paths), or keep the
credential where the harness expects it and give each app its own history
directory.

## Done when

- A boxed session cannot read another app's transcripts, checked by a test
  that asks the agent to list and read them.
- Both harnesses still refresh their login in a long-running gateway, and two
  apps' sessions at once do not fork the refresh chain.
- The approval page's sentence drops "and see other apps' conversations".

## Not in scope

Keeping the login out of the box (a credential-injecting egress) is not
pursued; see the accepted risk in [credentials](credentials.md).
