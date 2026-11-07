# How work is tracked

Agent Connect tracks its work in Markdown in this repository. Nothing needs an
external issue tracker.

## Where things go

- **Defects** (something the product does wrong today) live in
  [`docs/issues/`](../issues/), one file each, listed in its README.
- **Ideas** (proposals nobody has accepted yet) live in
  [`docs/ideas/`](../ideas/), listed in its README. Accepting one means moving
  it into `docs/plan/`, not editing its status in place.
- **Plans** (accepted work) live in [`docs/plan/`](../plan/), listed in its
  README. A small piece of work is one file. Work with several steps gets a
  folder: `docs/plan/<slug>/spec.md` says what and why, and
  `docs/plan/<slug>/issues/NN-<slug>.md` holds one ticket per step, numbered
  from `01`.
- **Decisions** live in [`docs/decisions/`](../decisions/) as ADRs.
- **Where the project stands** (releases, what CI proves, what is still
  unqualified) is [`docs/plan/current-work.md`](../plan/current-work.md). It
  points at the rest; it does not repeat it.

## A ticket's header

Every issue, idea and ticket starts with its title and a few header lines:

```markdown
# Run the gateway scenarios concurrently

Status: ready-for-agent
Blocked by: 01
```

`Blocked by:` names other tickets in the same folder by number, or other
files by link. Leave it out when nothing blocks the ticket. Later discussion
goes under `## Comments` at the end, newest last, each entry dated.

## Status

| Status            | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `needs-triage`    | Someone has to decide whether and how to act on it         |
| `needs-info`      | It cannot move until someone reproduces or measures it     |
| `ready-for-agent` | Specified well enough for an agent to do it alone          |
| `ready-for-human` | Needs the owner: credentials, hardware, a decision, a push |
| `in-progress`     | Someone is working on it                                   |
| `done`            | Finished; the commit that finished it is named below       |
| `wontfix`         | Decided against; the reason is written below               |

## Closing

A fixed defect or a finished plan moves to [`docs/archive/`](../archive/)
(`docs/archive/issues/`, `docs/archive/plans/`), and its line leaves the
README that listed it. Update links that pointed at it. A ticket inside an
active plan folder stays where it is with `Status: done` until the whole plan
moves.
