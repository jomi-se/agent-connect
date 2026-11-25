# Each app sees only its own conversations

Status: ready-for-agent. Accepted by the owner on 2026-11-25. The MCP-over-ACP
binding migration it waited for shipped in gateway 0.0.7 (90f550b).

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

## Checked with real turns (2026-11-25, same versions)

1. **Claude: works.** With `CLAUDE_SECURESTORAGE_CONFIG_DIR` on the
   dedicated login's directory and an empty per-app `CLAUDE_CONFIG_DIR`, a
   real turn signed in and answered. Its `.claude.json`, `projects/`,
   `sessions/` and backups landed only in the app's directory; the login
   directory's history, sessions and credentials were unchanged. No token
   refresh happened; the code writes the credential to the secure-storage
   directory, so a refresh should land in the shared one.
2. **Codex: works.** With the shared `CODEX_HOME`, a per-app directory
   mounted over `sessions/`, and `-c sqlite_home=… -c log_dir=…` pointing at
   per-app directories, a real `codex exec` turn answered. The session file
   and every database (state, memories, thread history, queue, goals, logs)
   landed only in the app's directories. The shared home gained only caches
   (`models_cache.json`, app-tool metadata), no conversation content.
   `session_index.jsonl` and `shell_snapshots/` were not written by this
   run; check them under codex-acp, which may write both.

Still open:

3. Two apps' sessions at once against one login, through a token refresh,
   without one invalidating the other. The login stays one shared directory
   (with Codex's lock files), as today, so this should hold; it needs a refresh
   to prove.
4. Codex memories are per app by construction now (`memories_1.sqlite` sits
   in the app's `sqlite_home`).

## Steps

1. Per-grant state directory beside the shared login: the gateway creates
   one private directory per grant (Claude config, Codex sessions, Codex
   SQLite and logs) and removes it with the grant.
2. Box arguments: mount the shared login and the grant's directory, set
   `CLAUDE_SECURESTORAGE_CONFIG_DIR`/`CLAUDE_CONFIG_DIR` for Claude and the
   `sessions/` mount, `sqlite_home` and `log_dir` for Codex.
3. The test from "Done when": an app's agent lists and reads the home and
   finds no other app's conversation, under both harnesses.
4. Session resume and the dropped-socket replay keep working (they read the
   harness's history, now per grant).
5. Approval page sentence; docs for the new layout.

## Done when

- A boxed session cannot read another app's transcripts, checked by a test
  that asks the agent to list and read them.
- Both harnesses still refresh their login in a long-running gateway, and two
  apps' sessions at once do not fork the refresh chain.
- The approval page's sentence drops "and see other apps' conversations".

## Not in scope

Keeping the login out of the box (a credential-injecting egress) is not
pursued; see the accepted risk in [credentials](credentials.md).
