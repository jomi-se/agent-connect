# Future investigation: provider-owned conversation recovery and library

Status: proposed, not started. Product intent captured 2026-09-09.

## Goal

When an application reloads a still-valid Agent Connect conversation, it should
look and feel as though nothing happened. OpenClaw remains the source of the
active conversation history; Agent Connect owns the grant-scoped link and safe
retrieval; the application owns presentation.

The first library is application-facing. Each application can list and open the
active conversations reachable through its current grant or start a new one.
It is not a cross-application owner-console archive. Displayed availability
ends with the provider lifetime; locally persisted Bookhand Study data is a
separate product concept and must not become a second chat authority.

## Why investigation comes first

The current execution-history projection reduces upstream messages to
`{ kind: "input" | "assistant", text }`. An `input` may be a human prompt or an
application/tool output. That loss of provenance caused Bookhand to render raw
reading context, search results, mutation receipts, and duplicated JSON as peer
chat messages after reload. A UI-only “hide JSON” heuristic cannot faithfully
recreate the original conversation.

Inspect the deployed and current OpenClaw source and representative
history responses to determine:

- which stable roles, content block types, response boundaries, timestamps,
  and tool-call relationships are available;
- whether OpenClaw supplies a truthful conversation label, preview, or search
  primitive;
- which fields can cross the application boundary without exposing reasoning,
  native instructions, credentials, or unrelated provider metadata;
- the smallest typed Agent Connect projection that lets an application recover
  the human-visible prompt and final answer while optionally summarizing tool
  activity.

Prefer preserving stable provider provenance over persisting a duplicate
transcript or teaching applications provider-specific event shapes. If the
existing SDK contract cannot carry the minimum projection, specify the smallest
additive SDK change after the provider inspection rather than assuming one now.

## Library behavior

- The application shows active conversations for its grant and offers **Open**
  and **New conversation**. Reopening continues only when Agent Connect says the
  checkpoint remains continuable.
- Identification uses truthful provider metadata when available. If OpenClaw
  exposes no stable title or distinguishable first user prompt, fall back to
  activity time and non-content metadata instead of inventing a label.
- Search is included only if it can be implemented over a provider-supported or
  safely projected bounded index. Do not download unbounded histories or create
  a hidden permanent transcript store merely to offer search.
- Restored presentation marks truncation and unavailability honestly. It never
  re-executes a prompt, native tool call, or application effect.

## Acceptance outcomes

- A focused Bookhand scenario restores a learner prompt, intermediate reading
  and Study operations, and final Tutor answer into the same human-visible
  structure shown before reload; raw envelopes are not rendered as chat.
- Multiple active conversations under one grant can be distinguished with the
  best truthful metadata OpenClaw supplies, opened, and continued independently.
- Expired, changed, truncated, or non-continuable histories have explicit UI
  states and cannot trigger replay.
- Provider ownership, grant isolation, one-active-request rules, cancellation,
  and Bookhand's independent persisted Study data remain unchanged.
