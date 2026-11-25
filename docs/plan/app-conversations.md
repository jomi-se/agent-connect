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

## What each harness does (checked 2026-11-25, Codex 0.171, Claude Code in claude-agent-acp 0.112)

- **Claude Code** reads its credentials from `CLAUDE_SECURESTORAGE_CONFIG_DIR`
  when set, a directory separate from `CLAUDE_CONFIG_DIR`, where its history
  (`projects`, `sessions`, `history.jsonl`, …) lives. It writes
  `.credentials.json` atomically (a temporary file renamed over it) and
  refuses symlinked or hard-linked credential files. So a shared credential
  _directory_ mounted into each app's own config directory should work; a
  single mounted file would not.
- **Codex** keeps `auth.json` in `CODEX_HOME` beside everything else:
  `sessions/`, `session_index.jsonl`, and SQLite databases for state,
  memories, logs, goals and the queue. It locks (`auth.json.lock`,
  `auth.lock`) and replaces the file: with `auth.json` bind-mounted as a
  single file, `codex login --with-api-key` saved nothing and said so only by
  not saying "API key saved". It has `sqlite_home` and `log_dir` settings
  that move the databases and logs. No setting was found that moves
  `auth.json` or `sessions/` apart.

## Unknowns to settle first

1. Claude: a session with `CLAUDE_SECURESTORAGE_CONFIG_DIR` on the shared
   login and `CLAUDE_CONFIG_DIR` per app signs in and refreshes, and its
   history lands only in the app's directory.
2. Codex: the shared `CODEX_HOME` with `sqlite_home`, `log_dir` and per-app
   directories mounted over `sessions/` (and the session index) keeps every
   conversation trace per app; list what else it writes while a session runs.
   The alternative is a per-app `CODEX_HOME` with the gateway carrying
   `auth.json` between them under its lock, which forks the refresh chain
   unless only one copy refreshes.
3. Both: two apps' sessions at once against one login, through a token
   refresh, without one invalidating the other.
4. Codex memories (`memories_1.sqlite`): per app, or the owner's across apps?
   It is history-like, so per app by default.

## Done when

- A boxed session cannot read another app's transcripts, checked by a test
  that asks the agent to list and read them.
- Both harnesses still refresh their login in a long-running gateway, and two
  apps' sessions at once do not fork the refresh chain.
- The approval page's sentence drops "and see other apps' conversations".

## Not in scope

Keeping the login out of the box (a credential-injecting egress) is not
pursued; see the accepted risk in [credentials](credentials.md).
