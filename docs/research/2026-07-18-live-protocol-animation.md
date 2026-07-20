# Live protocol animation direction

Date: 2026-07-18

Status: researched direction; deliberately deferred until the multi-scenario
demo is coherent.

## Goal

Add one signature diagram that makes the otherwise invisible Agent Connect
exchange legible while it happens. The diagram must react to actual SDK and
gateway events. It is not a looping illustration and must never delay protocol
processing so its animation can catch up.

The useful sequence is:

1. application SDK challenges the gateway;
2. gateway proves its pinned identity;
3. browser redirects to gateway-owned authorization when needed;
4. task and fixed application tool snapshot travel to the gateway;
5. provider adapter delivers the task to the selected runtime;
6. the runtime requests an application tool;
7. the request returns through the gateway to the browser;
8. the browser executes the tool and returns the correlated result;
9. the runtime completes the task.

Desktop should use a horizontal stage. Mobile should use a separately composed
vertical stage. Both consume the same semantic animation events.

## What the Bun reference actually does

The interactive adversarial-review sequence in Bun's
[Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust) article looks rich,
but its implementation is intentionally small:

- an `IntersectionObserver` starts the sequence once it is substantially in
  view;
- messages begin at `opacity: 0` and `translateY(4px)` and transition over
  roughly 350 ms;
- a few scheduled steps reveal the implementer message, reviewer finding, bad
  lines, and fix;
- `requestAnimationFrame` drives number counters;
- the play button advances or replays chapters;
- `prefers-reduced-motion` skips the staged movement and reveals the final
  state immediately.

The lesson is not to copy the dark terminal treatment. It is to use a stable
stage, reveal meaningful state in a deliberate order, and give the visitor
replay control. Agent Connect can improve on the reference because its stages
can be driven by real task and tool events rather than a timer-authored story.

## Recommended implementation

Use semantic HTML for actor labels and a responsive SVG overlay for paths. Keep
the controller library-free initially:

- CSS handles node color, emphasis, and short state transitions;
- the Web Animations API handles interruptible packet movement and exposes
  playback controls;
- SVG `stroke-dasharray` / `stroke-dashoffset` or normalized `pathLength`
  handles path activation;
- CSS motion paths or SVG geometry move a small request/result marker between
  actors;
- one animation state machine maps existing `AgentTaskEvent` values plus SDK
  authorization events to named segments.

The native
[Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API)
is enough for the first implementation: `Element.animate()` returns an
`Animation` with play, pause, cancel, completion, and timeline controls. CSS
[motion paths](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Motion_path)
can move an element along a fixed route by animating `offset-distance`. SVG
[`stroke-dashoffset`](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/stroke-dashoffset)
is broadly available for drawing or activating a connection path.

If hand-authored sequencing becomes cumbersome, Motion is the preferred small
dependency rather than a canvas/WebGL stack. Its
[`animate`](https://motion.dev/docs/animate) API supports interruptible
timelines, SVG path drawing, CSS variables, and motion along paths; the mini
build is approximately 2.3 kB and the hybrid build approximately 18 kB according
to its documentation. Do not add it until the native spike demonstrates an
actual coordination problem.

## Event mapping

The diagram controller should accept semantic events rather than gateway wire
payloads directly:

```ts
type DiagramEvent =
  | { type: "gateway.challenge.started" }
  | { type: "gateway.verified" }
  | { type: "authorization.required" }
  | { type: "authorization.completed" }
  | { type: "task.sent" }
  | { type: "task.started" }
  | { type: "tool.requested"; name: string; actionId: string }
  | { type: "tool.completed"; name: string; actionId: string }
  | { type: "task.completed" }
  | { type: "task.failed"; stage: string };
```

Each event updates the durable diagram state immediately and optionally adds a
short animation segment. When events arrive faster than the visuals:

- never buffer or delay protocol processing;
- cancel obsolete emphasis animations;
- preserve the newest durable node/path state;
- cap each packet trip around 300–450 ms;
- provide replay from the recorded semantic event log after completion.

## Motion language

- **Request:** a compact solid marker travels app → gateway → runtime.
- **Tool call:** the runtime path activates in reverse and the tool name arrives
  at the application boundary.
- **Tool result:** a second marker returns with the stable action id visually
  paired to the request.
- **Completion:** active paths settle; the changed application surface receives
  one restrained confirmation transition.
- **Failure:** motion stops at the responsible boundary and that node becomes
  the recovery focus. Do not animate an alarming page-wide error.

Most feedback transitions should stay in the 150–250 ms product range. The
moving marker can take 300–450 ms because its purpose is spatial explanation.
The performance baseline remains transform and opacity where possible; web.dev's
[animation performance guidance](https://web.dev/articles/animations-guide)
warns against casually animating layout- and paint-triggering properties.

## Accessibility and verification

The widely available
[`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion)
query must switch to instant path/node state changes with no moving packet. The
text event log and application result remain the complete source of meaning;
motion is never the only signal.

Validation should cover:

- every semantic event maps to a deterministic durable diagram state;
- rapid events cancel or fast-forward obsolete motion without losing state;
- desktop and mobile stages show the same event ordering;
- reduced-motion mode has no spatial movement;
- the diagram remains usable when JavaScript animation fails;
- a real mobile trace stays smooth while session SSE events are streaming.

## Decision

Build the multi-scenario demo first. Then implement a responsive SVG spike,
driven by the real semantic event log, with the native Web Animations API.
Adopt Motion only if the spike proves that native timeline coordination is
materially harder to maintain. Do not use Three.js, canvas, Rive, or an
endlessly looping decorative network animation for this surface.
