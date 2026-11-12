# Persistent workspaces an application can request

Status: needs-triage

Every session gets a disposable box with no mounts, and an application cannot
ask for one ([ADR 0008](../decisions/0008-control-plane-and-runtime-confinement-boundary.md):
it "cannot request a weaker sandbox, new host mount…"). That is right for
lending an agent to an application, but it means the agent starts with nothing
each time. Whatever it should know comes back through the application's tools,
and whatever it builds up — notes on the person, files it derived, small
scripts it wrote for itself — dies with the box.

Some applications want an agent that keeps a desk:

- **A tutor in a reading app** (Bookhand). The reader's memories and artifacts
  belong in the page, so they survive a change of model or provider. The
  tutor's own working material is a different thing: worked examples, a
  scratch notebook for the chapter, an index it built over the book. That
  material is cheaper to keep than to rebuild through tools every session.
- **A creative partner in a personal image-prompting app.** It learns the
  owner's taste over months, keeps notes on what landed, and searches a large
  archive of past chats and prompts that the owner wants it to read
  directly rather than one tool call at a time.

## The shape

Persistence is a capability the application requests and the owner binds, the
same split ADR 0008 already uses for posture:

- **The application asks** for a persistent workspace, as required or
  optional, the way it already relies on resumable sessions.
- **The owner decides on the consent page:** a new workspace for this
  application, an existing one, or none (ephemeral). The gateway creates and
  names the volume; the application never names a path.
- **One workspace per application origin**, never shared between applications
  or across owners.
- **Feeding it is the owner's alone.** Gateway configuration can add
  owner-chosen material to an application's workspace, read-only by default
  (an archive, a book collection). No application request can cause that.
- **Declined but required** means the gateway refuses the session and says
  why, rather than running ephemeral and letting the application believe
  otherwise.
- **On revocation** the owner chooses keep or wipe. Workspaces are listed,
  sized and deletable in the owner's controls.

## Questions

- **Persistent injection.** Content an agent was tricked into writing stays
  for the next session. The consent page should say that this agent
  remembers, wiping must be one step, and a workspace may want a history the
  owner can roll back.
- **Relation to conversation restore.** [Continue a conversation after the
  page reloads](continue-after-reload.md) keeps the harness's history. A
  workspace keeps files. They may share a storage mechanism, but the owner
  controls them separately.
- **Shared harness home.** Transcripts already cross grants through the
  shared harness home (ADR 0016). A per-app workspace sits beside that and
  does not fix it.
- **Where the line sits with application-owned memory.** An application that
  keeps the person's memories in its own store for portability should keep
  doing so. The workspace is the agent's desk, not the record of the
  relationship.
- **Runtime work.** Quotas, backups, survival across box teardown, and how
  the harness finds the workspace (working directory, an instructions file).
  ADR 0008 gives mounts and persistence to the runtime adapter.
- **Concurrency.** Two sessions of one application against one workspace:
  lock, refuse, or allow with a warning.
