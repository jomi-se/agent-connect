---
name: Agent Connect Gateway Authorization
description: A calm, explicit authorization system for a user-operated agent gateway.
colors:
  ground: "oklch(0.972 0.006 250)"
  plate: "oklch(1 0 0)"
  ink: "oklch(0.2 0.018 250)"
  ink-raised: "oklch(0.27 0.022 250)"
  muted: "oklch(0.46 0.018 250)"
  line: "oklch(0.85 0.012 250)"
  line-strong: "oklch(0.7 0.018 250)"
  soft: "oklch(0.935 0.01 250)"
  app-coral: "oklch(0.56 0.16 32.1)"
  gateway-teal: "oklch(0.43 0.09 190)"
  agent-periwinkle: "oklch(0.52 0.15 275)"
  signal-amber: "oklch(0.79 0.14 83)"
  danger: "oklch(0.5 0.18 25)"
  danger-soft: "oklch(0.96 0.03 25)"
  success: "oklch(0.48 0.12 150)"
typography:
  display:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(1.55rem, 5vw, 2rem)"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.025em"
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.05rem"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.5
rounded:
  control: "0.625rem"
  choice: "0.625rem"
  plate: "0.875rem"
spacing:
  compact: "0.45rem"
  control: "0.75rem"
  body: "1rem"
  section: "1.5rem"
  plate: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.plate}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1rem"
    height: "3rem"
  button-primary-hover:
    backgroundColor: "{colors.ink-raised}"
    textColor: "{colors.plate}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1rem"
    height: "3rem"
  button-danger:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1rem"
    height: "3rem"
  text-field:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.72rem 0.8rem"
    height: "3rem"
  authorization-plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
---

# Design System: Agent Connect Gateway Authorization

## Overview

**Creative North Star: "The Owner's Authorization Plate"**

Agent Connect uses the familiar topology of a modern identity-provider flow without borrowing a vendor's identity or implying that familiarity is proof of security. A cool work surface holds one crisp authorization plate whose stable brand, reading order, and action placement carry authentication, consent, errors, and access management. Application context appears inside the plate only when a requesting application is in scope. The three-circle Canvas wordmark and its actor palette are the shared Agent Connect identity.

The system is calm, candid, and capable. It favors workhorse type, plain authority language, generous breathing room, and restrained state color over decorative security imagery or dashboard density. On narrow screens, the plate becomes the page while preserving the same order and explicit owner choices.

**Key Characteristics:**

- One centered authorization plate on wide screens and one full-width task surface on phones.
- Workbench-ink hierarchy, quiet cool neutrals, and actor colors inherited from the Canvas application.
- Authority details disclosed progressively without hiding application identity or owner choices.
- Status expressed with wording as well as restrained color.

## Colors

The palette is inherited from the Agent Connect Canvas: dark workbench ink establishes hierarchy and primary action, while coral, teal, and periwinkle identify the application, gateway boundary, and agent. Functional color clarifies responsibility rather than decorating the page.

### Primary

- **Workbench Ink:** The authoritative neutral for headings and primary actions.
- **Application Coral:** Identifies the requesting application and its avatar.
- **Gateway Teal:** Marks links, selected restricted profiles, radio controls, and the authorization boundary.
- **Agent Periwinkle:** Provides the high-visibility keyboard-focus outline.

### Tertiary

- **Revocation Red:** Destructive action text and borders, paired with explicit destructive wording.
- **Danger Wash:** Low-intensity destructive or error background.
- **Active Green:** Active grant status, always accompanied by the word “Active.”
- **Pending Amber:** Pending request status, always accompanied by the word “Pending.”

### Neutral

- **Cool Work Surface:** The page field surrounding the authorization plate on wider viewports.
- **Crisp Plate:** The foreground task surface and control fill.
- **Authorization Ink:** Headings, labels, and high-priority owner information.
- **Candid Slate:** Supporting copy, metadata, help, and secondary facts.
- **Quiet Rule:** Structural dividers and low-emphasis choice boundaries.
- **Soft Wash:** Empty states and secondary hover fills.
- **Strong Structural Gray:** The stronger neutral edge used where a field or secondary action must read as interactive.

### Named Rules

**The Actor Color Rule.** Coral means application, teal means gateway boundary, and periwinkle means agent/focus. Primary decisions remain workbench ink; semantic states keep their own restrained colors.

**The Words Carry Status Rule.** Color may reinforce state, but active, pending, expired, revoked, and problem states must remain understandable from their text.

## Typography

**Display Font:** Native humanist sans-serif stack
**Body Font:** Native humanist sans-serif stack
**Label Font:** Native humanist sans-serif stack

**Character:** The single system stack is familiar, fast, and deliberately unbranded. Hierarchy comes from weight, scale, spacing, and compact negative tracking rather than a decorative display face.

### Hierarchy

- **Display:** Bold, responsive task titles with a compact line height and slight negative tracking; used once per task surface.
- **Title:** Bold section headings with restrained negative tracking; used for authority groups and console regions.
- **Body:** Regular explanatory and operational prose, normally kept to a readable measure of about 62 characters.
- **Label:** Bold compact text for controls, statuses, field labels, and supporting metadata.

### Named Rules

**The Workhorse Type Rule.** Use one native sans-serif family and let content hierarchy—not typographic novelty—carry the authorization flow.

## Layout

The task shell is centered in the viewport with responsive outer padding. Authentication and consent use a compact plate capped at 32rem; the owner console expands to 62rem so operational records remain scannable without becoming a dashboard.

Plate content follows a stable sequence: requesting-application context when applicable, the current task, then an action region. Owner-only pages rely on the global product mark and begin directly with the task instead of repeating Agent Connect inside the plate. Header, body, and footer use responsive padding between 1.25rem and 2rem. Sections are separated primarily by vertical rhythm; fine rules are reserved for structural boundaries.

At 560px and below, outer padding and decorative elevation disappear. The plate becomes a full-width, square-cornered task surface sized against the dynamic viewport. Actions form two equal columns. Sparse authentication pages keep their action row immediately after the form content; longer consent pages retain a sticky bottom row so the decision remains reachable while reviewing authority. Console facts collapse from term/value pairs to a single column, while actions expand to the available width.

**The Stable Reading Order Rule.** Responsive changes may alter width, padding, and columns, but never reorder application identity, the current task, authority details, and owner actions.

## Elevation & Depth

The system is flat within the plate and uses tonal layering plus fine rules for most separation. On wider screens, one diffuse ambient shadow lifts the authorization plate from the cool ground (`0 0.5rem 1.8rem oklch(0.2 0.018 250 / 0.1)`). Mobile removes that shadow because the plate becomes the page.

### Shadow Vocabulary

- **Authorization Plate:** A single cool, diffuse shadow used only around the desktop plate; controls and internal sections do not stack additional shadows.

### Named Rules

**The One Lift Rule.** Only the desktop authorization plate is elevated; hierarchy inside it comes from spacing, rules, and tonal fills.

## Shapes

Forms are softly squared rather than pill-like. The outer plate uses the largest restrained corner, selectable profiles use a slightly tighter corner, and inputs and buttons share the smallest control corner. Fine one-pixel borders establish boundaries; fully round geometry is limited to status dots.

On phone layouts, the outer plate loses its radius while component corners remain intact. This makes the surface feel native to the viewport without changing the component language.

**The Nested Corner Rule.** Corners tighten as elements nest: plate, then choice, then control. Do not introduce ornamental pills or mixed corner styles.

## Components

### Buttons

- **Shape:** Gently squared controls with shared height and padding; mobile actions stretch to equal columns.
- **Primary:** Solid Workbench Ink with crisp white text for Continue, Allow access, and Review request.
- **Hover / Focus:** Primary actions lift to Raised Ink on hover; every variant uses the shared three-pixel Agent Periwinkle outline with a two-pixel offset for keyboard focus.
- **Secondary:** White with a Strong Structural Gray edge and Workbench Ink text; used for Cancel and other non-destructive alternatives.
- **Danger:** White with restrained red text and border; the fill becomes a pale danger wash on hover.

### Cards / Containers

- **Corner Style:** The desktop plate uses the system's broadest restrained radius; selectable profiles and empty states use the middle radius.
- **Background:** The main plate remains crisp white; selected choices and empty states use pale tonal washes.
- **Shadow Strategy:** Only the outer desktop plate carries elevation.
- **Border:** Choice cards use one-pixel neutral borders; the selected choice shifts to a Gateway Teal edge and pale teal fill.
- **Internal Padding:** Plate regions breathe at the large spacing steps; choice cards use compact one-rem-scale padding.

### Inputs / Fields

- **Style:** White fields with a visible neutral edge, shared control radius, and a three-rem minimum touch height.
- **Focus:** The same explicit Agent Periwinkle outline used by every interactive element.
- **Error:** Error text is associated to the field and displayed in a pale danger wash with specific recovery language.

### Navigation

The product mark anchors the shell rather than acting as a navigation bar. The Canvas three-circle wordmark—Application Coral, Gateway Teal, then Agent Periwinkle—and bold name sit above the plate on desktop and in a shallow ground-colored band on phone layouts. No unrelated destinations compete with the active authorization task.

### Authorization Choice

Each restricted profile is a full-row radio target with a bold profile name, candid description, and explicit native-capability summary. Selection uses border and background together with the native radio state; the whole row receives the shared focus treatment.

### Status

Compact text statuses pair a small colored dot with a bold state word. They sit beside the associated grant on wide screens and wrap beneath its title on phones; color is never the only state signal.

## Do's and Don'ts

### Do:

- **Do** preserve the same shell and action placement across owner authentication, consent, problems, and access management; include the context header only for application-scoped requests.
- **Do** name the requesting application before asking the owner to authenticate or authorize.
- **Do** keep application tools visibly distinct from native capabilities and selected restricted profiles.
- **Do** provide explicit keyboard focus, touch-sized controls, reduced-motion behavior, and text alongside every semantic color.
- **Do** let mobile become a full-width task surface while preserving the desktop reading order.

### Don't:

- **Don't** use visual familiarity, color, or a polished plate as evidence of security; the copy must state actual authority and boundaries.
- **Don't** add decorative security imagery, trust scores, ornamental dashboards, or unexplained protocol language.
- **Don't** hide cancel or revocation behind low-contrast links, menus, or color-only warnings.
- **Don't** introduce a second affirmative accent, stacked card shadows, pill-shaped controls, or a decorative display face.
