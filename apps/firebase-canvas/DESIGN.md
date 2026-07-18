---
name: Agent Connect Canvas
description: A live workbench for lending web application tools to a user-owned agent.
colors:
  background: "oklch(1 0 0)"
  surface: "oklch(0.972 0.006 250)"
  surface-strong: "oklch(0.935 0.01 250)"
  ink: "oklch(0.2 0.018 250)"
  muted: "oklch(0.46 0.018 250)"
  border: "oklch(0.85 0.012 250)"
  app-coral: "oklch(0.56 0.16 32.1)"
  connector-teal: "oklch(0.43 0.09 190)"
  agent-periwinkle: "oklch(0.52 0.15 275)"
  signal-amber: "oklch(0.79 0.14 83)"
  success: "oklch(0.48 0.12 150)"
  danger: "oklch(0.5 0.18 25)"
typography:
  headline:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 7vw, 5.5rem)"
    fontWeight: 720
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 450
    lineHeight: 1.6
  label:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 650
    lineHeight: 1.3
  code:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 450
    lineHeight: 1.6
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.background}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "14px 18px"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "13px 18px"
    height: "48px"
  field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  code-panel:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.background}"
    typography: "{typography.code}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

# Design System: Agent Connect Canvas

## Overview

**Creative North Star: "The Open Workbench"**

Agent Connect Canvas is a precise workbench in a bright studio: the useful machinery is visible, every handoff is marked, and nothing important is hidden behind decorative spectacle. The interface begins as a focused product tool, then opens outward into a live explanation of the system carrying the task.

The neutral foundation keeps the application calm while a functional palette identifies the web app, connector, agent, in-flight work, and outcome. Density increases only when the visitor asks for technical depth. Mobile and desktop are independently composed over the same behavior: mobile is linear and disclosure-led; desktop keeps the workbench and supporting evidence visible together. The system explicitly rejects futuristic science-fiction AI interfaces, generic gradient-heavy AI startup landing pages, terminal-first hacker demos, and dense enterprise-security dashboards.

**Key Characteristics:**

- Neutral-first product surfaces with color reserved for actors and state.
- A real execution trace, not a decorative architecture illustration.
- Familiar controls and code artifacts that make the integration credible.
- Crisp structure, compact radii, and purposeful state motion.
- Desktop clarity with a complete touch-first mobile path.
- Separate mobile and desktop compositions with a shared behavioral contract.
- Demo apps with independent product chrome, typography, and brand palettes so
  they read as third-party consumers rather than Agent Connect components.

## Colors

The palette maps color to responsibility. It is a navigation aid for the system, never ambient decoration.

### Primary

- **Workbench Ink:** The authoritative neutral for headings, body text, primary actions, and code surfaces.
- **Application Coral:** Identifies the browser application and the tool it lends to the agent. It is brand color, not an error color.

### Secondary

- **Connector Teal:** Marks the connector, runtime identity, authorization boundary, and verified trust state.
- **Agent Periwinkle:** Marks the remote agent, task execution, and streamed agent output.

### Tertiary

- **Signal Amber:** Appears only while a handoff or tool request is waiting for completion.
- **Success Green:** Confirms a completed and applied operation.
- **Danger Red:** Reserved for failure, revocation, invalid credentials, and destructive warnings.

### Neutral

- **True White:** The page background and highest-clarity reading surface.
- **Cool Work Surface:** Separates working regions without turning every region into a card.
- **Structural Gray:** Dividers, field boundaries, and inactive paths.
- **Muted Ink:** Supporting text that remains readable against white and cool surfaces.

### Named Rules

**The Actor Color Rule.** Coral means app, teal means connector, and periwinkle means agent everywhere. Never reuse them as generic decoration.

**The Semantic Red Rule.** Application Coral may identify an actor, but Danger Red alone communicates failure or revocation. Never use either for arbitrary emphasis.

**The Neutral Majority Rule.** Neutral surfaces occupy most of every viewport. Functional colors clarify the flow; they do not flood it.

## Typography

**Display Font:** Figtree Variable with the system sans-serif stack
**Body Font:** Figtree Variable with the system sans-serif stack
**Label/Mono Font:** IBM Plex Mono with the native UI monospace stack

**Character:** One restrained sans-serif keeps the product familiar and trustworthy. Monospace is reserved for code, commands, identifiers, and event payloads so implementation evidence reads differently from explanation.

### Hierarchy

- **Headline** (720, responsive up to 5.5rem, 0.98): The central product claim; never used inside controls.
- **Title** (700, 1.375rem, 1.2): Working sections, diagrams, and integration steps.
- **Body** (450, 1rem, 1.6): Explanations capped near 70 characters per line.
- **Label** (650, 0.8125rem, 1.3): Controls, state names, and compact metadata in sentence case.
- **Code** (450, 0.8125rem, 1.6): SDK snippets, terminal commands, events, and runtime identifiers.

### Named Rules

**The Evidence Voice Rule.** Prose explains; monospace proves. Never use monospace to make ordinary marketing copy look technical.

**The Quiet Label Rule.** Labels use weight and proximity, not all-caps tracking, to establish hierarchy.

## Elevation

The system is flat by default and structural when layered. Borders and tonal contrast define permanent regions. A compact shadow is allowed only for an element that temporarily rises above the page, such as a focused live demo or transient status surface.

### Shadow Vocabulary

- **Workbench lift** (`box-shadow: 0 6px 8px oklch(0.2 0.018 250 / 0.08)`): The maximum resting elevation for the interactive demonstration.
- **Focus lift** (`box-shadow: 0 0 0 3px oklch(0.52 0.15 275 / 0.22)`): Reinforces keyboard focus alongside a visible outline.

### Named Rules

**The Structural-First Rule.** Use spacing, dividers, and surface contrast before adding shadow. Never pair a decorative wide shadow with a decorative border.

## Components

### Buttons

- **Shape:** Compact, confident corners with a medium radius.
- **Primary:** Workbench Ink with white text and a 48px touch target.
- **Hover / Focus:** A small contrast shift, visible outline, and no scale animation.
- **Secondary:** White surface with a structural border; destructive actions use text and explicit copy rather than an alarming filled control.

### Chips

- **Style:** Actor chips use a pale tonal fill and strong text in the actor's assigned color family.
- **State:** Active flow stages gain a solid status marker and `aria-current`; completed stages gain a success marker without changing their actor identity.

### Cards / Containers

- **Corner Style:** Restrained large radius for the live workbench and code panels only.
- **Background:** White or Cool Work Surface according to hierarchy.
- **Shadow Strategy:** Flat by default; the live workbench may use Workbench lift.
- **Border:** A single Structural Gray divider where tonal separation is insufficient.
- **Internal Padding:** Responsive spacing drawn from the 16px, 24px, and 40px steps.

### Inputs / Fields

- **Style:** White background, structural border, medium radius, and at least 44px of interactive height.
- **Focus:** A two-pixel Agent Periwinkle outline with offset; never rely on color fill alone.
- **Error / Disabled:** Errors include recovery copy and Danger Red; disabled controls retain readable text and clearly lose affordance.

### Navigation

The compact header keeps the product name, demo status, and a direct path to integration details. On mobile it wraps without hiding primary navigation or creating horizontal scrolling.

### Live Flow

The signature runtime component is an event-driven activity feed. It begins empty, then appends real connection, task, tool-request, tool-result, completion, and failure events. It must not imply that every task follows a predetermined tool path: a runtime may call no tools, one tool, or many tools.

### Embedded Demo Apps

The example project board, editor, and storefront are visually independent products mounted inside the Agent Connect workbench. Each owns its product name, navigation, palette, content model, and app chrome. Agent Connect appears only as a compact integration badge and in the surrounding connection controls; its actor colors and component styling do not leak into the embedded apps.

This boundary is part of the product explanation: application developers keep ownership of their interface and tools while Agent Connect supplies the user-owned-agent connection. Mobile may simplify each app's navigation, but it must preserve the independent brand and recognizable application structure.

### Gateway Setup Terminal

The gateway setup is the page's single scroll-triggered explanatory animation. It replays the current source-based install, build, and start sequence when the terminal enters the viewport. Pending lines remain faintly legible so the content never depends on animation; reduced-motion visitors receive the completed terminal immediately. The command sequence lives in one typed data structure in `src/main.ts` because the installation story will change as the gateway is packaged more ergonomically.

### Tool Contracts

The app-tools dialog translates JSON Schema into a compact human contract instead of exposing raw schema text. Every tool shows its purpose, browser ownership, top-level inputs, readable types, required or optional state, nested object fields, and allowed enum values. The presentation is derived from the actual schema used for authorization and execution; simplifying the display must never create a second hand-maintained tool definition.

## Do's and Don'ts

### Do:

- **Do** lead with the working interaction and let architecture unfold from real events.
- **Do** keep actor colors stable across diagrams, status messages, and code annotations.
- **Do** show runtime cards, scopes, tool schemas, and event payloads as real evidence behind progressive disclosure.
- **Do** preserve a complete 44px-target mobile flow and visible keyboard focus.
- **Do** use state motion between 150ms and 250ms and provide an immediate reduced-motion alternative.

### Don't:

- **Don't** create a futuristic science-fiction AI interface.
- **Don't** create a generic gradient-heavy AI startup landing page.
- **Don't** turn the experience into a terminal-first hacker demo that excludes web developers.
- **Don't** create a dense enterprise-security dashboard that makes the integration feel intimidating.
- **Don't** use gradients, glassmorphism, oversized radii, decorative grid backgrounds, or repeated card scaffolding.
- **Don't** claim the deterministic public runtime is Codex; label the connected runtime honestly while explaining the separately proven Codex path.
