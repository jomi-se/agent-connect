# Packed-artifact clean-room acceptance

Run `node scripts/clean-room.mjs [artifact-directory]` after preparing the
local release. The default directory is the ignored `dist/release`.
`AGENT_CONNECT_RELEASE_DIR` overrides it; `ACP_DOCKER_SOCKET` can select a local socket.
Setup builds the box from the installed tarball files; no prebuilt box is required.

The directory must contain `release.json`, npm tarballs for the gateway, the
current Linux platform binary and the web SDK, and `acp-chat-sample.tgz` with a
`package/` root. Packages are identified by their packed manifests and must
match `release.version` for gateway/platform packages and `release.sdkVersion`
for the independently versioned browser SDK. All manifest artifact sizes and SHA256
checksums are checked before installation.

The runner builds a fresh Node 24 image with pinned Playwright and Chromium,
and copies only the CLI binary from a digest-pinned Docker 29 image.
It copies only the test driver, a socket-interruption relay and the scripted
model fixture into its build context. Its runtime mounts contain only copied
release artifacts, a dedicated temporary run directory and the Docker socket.
It never mounts a repository checkout, SDK source or a prior build directory.

The fresh container installs the packed gateway and selected binary, builds the
standalone reader sample against the packed SDK's public ACP export, then uses
the CLI's normal `setup` local build and `serve --config` flow. The test
passphrase and HOME/XDG_STATE_HOME/XDG_CONFIG_HOME directories are isolated fixtures; initialization
creates no static application grant. A real Codex ACP adapter runs in the
release box with an isolated synthetic model; no account login,
provider API key, personal harness home or live model turn is involved.

Browser checks drive the real gateway owner sign-in, approval and denial pages,
then restore the tab-scoped managed grant on reload with a real rotating refresh
without resubmitting a prompt. They reject an application bearer at owner
endpoints and at a different browser origin. The owner grants page revokes
the active application grant and the sample clears its authorization without
replaying a prompt or tool effect. The prompt oracle recognizes the pinned real
Codex runtime's exact conversation-title maintenance instruction together with
its title-only JSON schema, reports those calls separately, and counts every
other model request. Tool-effect counters must also remain unchanged after
revocation. They cover one visible highlight, exactly one invocation per requested
application tool, interruption and reconnect during an unanswered reader
question with the same session, genuine browser back/forward-cache restoration
both while idle and while an app tool waits, and cancellation without a follow-up model
request. Diagnostics are retained under the printed temporary run directory.
The gateway permits only one active host. After Stop, the test explicitly opens
a new connection and completes another tool turn, retaining the cancelled
transcript and verifying that the previous question is not replayed.
The browser uses full Chromium's new headless mode with back/forward caching
enabled, and asserts `pageshow.persisted`; synthetic lifecycle events alone
cannot satisfy this gate. See [Playwright's browser reference](https://playwright.dev/docs/browsers#chromium-new-headless-mode).
The runner gives each test image a unique tag, runs the captured immutable
image ID, and removes only its own matching tag after its containers close. Identical
concurrent builds may share an image ID; other runs' tags are retained.
Containers and session networks created by this run are cleaned on success or
failure; retained directories are private and contain only generated fixture
credentials and grants.

The Docker socket is granted only to this trusted operator acceptance driver.
It is never mounted in a harness session. This is a test configuration, not a
deployment topology.
