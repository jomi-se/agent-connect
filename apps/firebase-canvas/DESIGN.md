---
name: Agent Connect Canvas
description: A bright, compact workbench that shows applications lending tools to a user-owned agent.
colors:
  workbench-ink: "#09172b"
  muted-ink: "#606878"
  structural-line: "#dde1e8"
  studio-ground: "#f7f7f8"
  paper: "#ffffff"
  application-coral: "#f46864"
  demo-action-coral: "#c94b48"
  gateway-teal: "#18a6b8"
  gateway-action-teal: "#087b88"
  interface-blue: "#417af4"
  agent-periwinkle: "#7464f2"
  agent-action-periwinkle: "#5948d7"
  signal-amber: "#ffb617"
  success-green: "#28a66f"
typography:
  title:
    fontFamily: "Figtree Variable, Figtree, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Figtree Variable, Figtree, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Figtree Variable, Figtree, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Figtree Variable, Figtree, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.35
  evidence:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  field: "6px"
  control: "7px"
  surface: "12px"
  dialog: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "22px"
components:
  button-demo:
    backgroundColor: "{colors.demo-action-coral}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "45px"
  button-connected:
    backgroundColor: "{colors.workbench-ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "43px"
  button-supporting:
    backgroundColor: "#eef0fb"
    textColor: "#38435b"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  gateway-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.workbench-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "0 52px 0 11px"
    height: "46px"
  workbench-surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.workbench-ink}"
    rounded: "{rounded.surface}"
    padding: "18px"
---

# Design System: Agent Connect Canvas

## Overview

**Creative North Star: "The Open Workbench"**

Agent Connect Canvas is a bright, product-neutral workbench whose first view is already the working product. A compact header, scenario rail, independently branded application, two honest entry paths, and correlated activity trace make the handoff visible without a marketing hero or decorative architecture prelude.

The interface is dense but calm: white and cool-gray surfaces carry most of the screen, thin rules establish structure, and saturated color identifies ownership or state. The deterministic in-browser demo and the live HTTPS OAuth gateway path remain visibly separate. Agent Connect supplies connection controls and evidence; each third-party application retains its own name, chrome, palette, content model, and tools.

**Key Characteristics:**

- Open Workbench in the first viewport; working proof is the lead.
- Independent third-party application ownership inside neutral Agent Connect chrome.
- Explicit simulated-demo and live-OAuth entry paths.
- Original overlapping three-circle Agent Connect mark in coral, teal, and periwinkle.
- Compact Figtree UI with IBM Plex Mono reserved for event evidence.
- Thin dividers, 12px major surfaces, and mostly 7px controls.
- One authored inline-SVG action-icon family with rounded strokes and simple geometry.
- Darker action fills preserve contrast while actor colors remain available as identity signals.

## Colors

The palette is a neutral studio with color assigned to actors, actionable state, and the independently owned applications.

### Primary

- **Workbench Ink:** The header text, strongest labels, connected-agent action, and other authoritative controls.
- **Application Coral:** The application actor in the Agent Connect mark and trace. The filled demo action uses the darker **Demo Action Coral** so white action text remains legible.

### Secondary

- **Gateway Teal:** The gateway actor in the mark and trace. The darker **Gateway Action Teal** is used when teal becomes a filled result or action surface.
- **Agent Periwinkle:** The user-owned agent actor in the mark and trace. The darker **Agent Action Periwinkle** carries white text on transient tool-flight surfaces.
- **Interface Blue:** Selected scenarios, focus treatment, links, and controls owned by the surrounding workbench rather than by an actor.

### Tertiary

- **Signal Amber:** Browser-tool and waiting states.
- **Success Green:** Completion and ready-state signals.

### Neutral

- **Studio Ground:** The cool-gray page canvas that keeps the workbench bright without becoming stark.
- **Paper:** The highest-clarity surface for panels, application canvases, fields, and cards.
- **Structural Line:** Hairline borders and row dividers.
- **Muted Ink:** Supporting instructions and trace metadata.

### Named Rules

**The Actor Color Rule.** Coral means application, teal means gateway, and periwinkle means user-owned agent in Agent Connect-owned explanations and traces. Embedded apps may use their own palettes because they are separate products.

**The Contrast Fill Rule.** Identity swatches may stay vivid, but controls with white text use the implemented darker coral, teal, periwinkle, or ink fills.

**The Neutral Majority Rule.** White and cool gray occupy most of every viewport. Color clarifies ownership and state; it does not become ambient decoration.

## Typography

**Display Font:** Figtree Variable with Figtree and sans-serif fallback

**Body Font:** Figtree Variable with Figtree and sans-serif fallback

**Evidence Font:** IBM Plex Mono with monospace fallback

**Character:** Figtree is compact, direct, and familiar enough to support three visibly different sample applications without imposing an Agent Connect house style on them. IBM Plex Mono distinguishes machine evidence from explanatory prose.

### Hierarchy

- **Title** (700, 22px, 1.2): The active third-party application's primary object, such as a project title.
- **Section title** (700, 18px, 1.2): Entry-path headings and embedded-app brands.
- **Body** (400, 13px, 1.45): Instructions and supporting product copy.
- **Label** (600, 11px, 1.35): Compact controls, tabs, table headings, and metadata.
- **Evidence** (400, 11px, 1.4): Correlated event details and machine-originated values only.

### Named Rules

**The Evidence Voice Rule.** Prose explains in Figtree; event details prove in IBM Plex Mono. Do not use monospace as decorative tech styling.

**The Compact Hierarchy Rule.** Hierarchy comes from weight, grouping, and ownership chrome rather than oversized type. This surface has no display-scale marketing headline.

## Layout

Desktop uses a single edge-to-edge workbench below the 72px header. Its first row is a 204px scenario rail, a flexible application stage, and a 300px entry rail; the activity trace spans the second row. The selected application is the visual center, while the two paths remain adjacent and comparable. Internal spacing clusters around 8px, 12px, 18px, and 22px to keep the proof dense enough to read as a tool.

At 760px and below, the same DOM becomes one deliberate vertical sequence: header, scenario choices, simulated-demo entry, application, connected-agent task form when opened, live connection entry, then activity trace. The connected task form is static content in normal mobile flow, never a viewport overlay. Horizontal scrolling is reserved for application content that is intrinsically board-like; the page itself does not become a squeezed desktop canvas.

**The Working-First Rule.** Do not place a marketing hero, runtime-card intake, or explanatory animation ahead of the workbench.

**The Ownership Layout Rule.** The application occupies the central working area and keeps its own internal navigation; Agent Connect controls frame it without masquerading as part of that application.

## Elevation & Depth

The system is structural first. Hairline borders and tonal separation define stable regions; a restrained cool shadow lifts the major white workbench surfaces from the studio ground. Deeper shadows are limited to transient overlays such as the connected task drawer on desktop and the tools dialog. On mobile, the task form loses overlay behavior and participates in the normal document flow.

### Shadow Vocabulary

- **Workbench lift** (`0 16px 36px rgb(18 28 48 / 8%)`): Major application and entry surfaces.
- **Quiet panel lift** (`0 8px 24px rgb(18 28 48 / 4%)`): The activity trace.
- **Transient lift** (`0 16px 42px rgb(9 23 43 / 18%)`): The desktop connected-task drawer only.

### Named Rules

**The Structural-First Rule.** Use spacing, dividers, and tonal contrast before shadow. Resting surfaces use one restrained lift, not stacked decorative effects.

## Shapes

Major workbench panels and embedded application canvases use gently compact 12px corners. Ordinary buttons and compact actions use 7px corners; the gateway field is slightly tighter at 6px. Dialogs may expand to 14px, while actors, avatars, and status dots use true circles or pills. The original Agent Connect mark is three overlapping circles—not a new glyph, monogram, or container badge.

Inline action icons share a small authored SVG vocabulary: 24px view boxes, current color, approximately 1.8px rounded strokes, and simple paths or circles. Filled glyphs are reserved for shapes such as Play and the Northstar spark. CSS-drawn scenario illustrations remain local navigation identifiers, not replacements for action icons.

**The Major-and-Control Rule.** Default to 12px for principal containers and 7px for controls; use another radius only when the implemented component has a distinct functional reason.

## Components

### Agent Connect Mark

Three equal overlapping circles—application coral, gateway teal, and agent periwinkle—form the original wordmark symbol. Preserve their left-to-right order, overlap, circular silhouette, and modest inset shading. Do not wrap the mark in a tile.

### Entry Paths

- **Simulated demo:** Coral play icon, explicit “Simulated · no account or model usage” note, and a darker coral full-width action.
- **Live connection:** Teal link icon, HTTPS gateway-address field, compact inline arrow action, setup-guide link, and an OAuth explanation.
- **Separation:** Neither path borrows the other's status or implies that the deterministic demo connected to a live model.

### Buttons and Action Icons

- **Shape:** Compact 7px corners with a minimum 43–45px primary action height.
- **Primary fills:** Dark demo coral for the simulated path; Workbench Ink for the connected-agent task action.
- **Supporting actions:** Pale cool fill or white with a structural border.
- **Hover / focus:** A darker fill shift on colored actions and the shared 3px translucent blue focus outline with offset.
- **Icons:** Use authored inline SVG with `currentColor`; keep stroke caps, joins, view boxes, and optical size consistent across more, add, play, link, arrow, external-link, pulse, and close actions.

### Scenario Rail

Desktop presents three stacked selectors with a slim blue active rule and a pale blue selected surface. Mobile converts them to equal compact tabs; descriptions and local CSS-drawn illustrations yield to the application names so the row remains scannable.

### Embedded Applications

Northstar, Fieldnotes, and Everyday are independent products. Each owns its product name, dark application header, navigation, content model, palette, and app-native controls. Agent Connect appears in the surrounding workbench and only as a compact integration badge where appropriate. Never recolor embedded app chrome into the Agent Connect actor palette merely for consistency.

### Gateway Field

The HTTPS address field is white with a 6px radius and structural border. Its arrow submission control occupies a 44px inline hit target at the field's right edge and has an accessible text label. Connection state and revocation remain separate text below the field.

### Connected Task Form

The task form opens only for the live connected path. On desktop it is a compact lifted drawer at the lower right; on mobile it is a full-width normal-flow card placed directly after the application. Its primary action uses Workbench Ink, not an actor color, because it submits work rather than representing an actor.

### Activity Trace

The trace is a compact table with stable actor-colored dots, Figtree event labels, and IBM Plex Mono details. It records actual connection, simulation, task, tool, result, completion, and failure events. On mobile the details column is removed while time, actor, and event remain visible.

### Tool Contracts and Tool Flight

The tools dialog derives readable contracts from the actual registered schemas. A single transient tool-flight pill may appear over the active application; correlated request, result, and error phases use darker periwinkle, teal, and coral fills with white text. The durable multi-event history remains in the activity trace.

## Do's and Don'ts

### Do:

- **Do** open on the working product and keep both entry paths visible and honestly labeled.
- **Do** preserve each third-party application's visual ownership and app-native controls.
- **Do** keep the original three-circle mark and the coral/app, teal/gateway, periwinkle/agent mapping in Agent Connect-owned evidence.
- **Do** use Figtree for interface language and IBM Plex Mono only for machine evidence.
- **Do** use darker accessible fills when white text sits on an action or transient status surface.
- **Do** keep the connected task form in normal flow on mobile and maintain clear keyboard focus and touch targets.

### Don't:

- **Don't** restore the runtime-card field, pre-workbench hero micro-flow, or animated setup terminal; the shipped workbench does not promise them.
- **Don't** merge the deterministic simulated demo with the live HTTPS OAuth gateway path.
- **Don't** make Agent Connect chrome look like it owns Northstar, Fieldnotes, or Everyday.
- **Don't** replace the inline SVG action family with emoji, mixed icon libraries, or inconsistent stroke weights.
- **Don't** use gradients, glassmorphism, oversized radii, decorative grid backgrounds, or sci-fi styling.
- **Don't** turn the page into a terminal-first setup guide or a dense enterprise-security dashboard.
