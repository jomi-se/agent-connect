---
name: Agent Connect
description: Owner pages served by your own gateway; a feed of what it did and what it needs from you.
colors:
  ground: "#f4f5f2"
  paper: "#ffffff"
  ink: "#202d2c"
  muted: "#566463"
  line: "#dbe2de"
  line-strong: "#97a9a3"
  teal: "#205e58"
  teal-ink: "#174a44"
  teal-soft: "#e7f1ed"
  orange: "#ce7849"
  orange-ink: "#8a4519"
  orange-soft: "#fcf1e8"
  orange-line: "#efcfb7"
  purple: "#7861ad"
  danger: "#a52e27"
  danger-soft: "#fdf0ed"
  danger-line: "#e3bab4"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "2rem"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 680
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  meta:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 650
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.9375em"
    fontFeature: '"liga" 0'
rounded:
  sm: "0.45rem"
  md: "0.5rem"
  lg: "0.65rem"
  xl: "0.9rem"
  full: "50%"
spacing:
  xxs: "0.25rem"
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.25rem"
  xl: "1.75rem"
  xxl: "2.25rem"
components:
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "0.6rem 1.15rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.teal-ink}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.6rem 1.15rem"
    height: "2.75rem"
  button-secondary-hover:
    backgroundColor: "{colors.ground}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "0.35rem 0.65rem"
    height: "2.25rem"
  button-quiet-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
  button-quiet-danger-hover:
    backgroundColor: "{colors.danger-soft}"
  input-text:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.65rem 0.8rem"
    height: "3rem"
  request-pinned:
    backgroundColor: "{colors.orange-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "1.15rem 1.25rem"
  panel:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
    padding: "1.75rem"
  origin-chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "0.3rem 0.6rem"
  option-selected:
    backgroundColor: "{colors.teal-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0.85rem 1rem"
---

# Design System: Agent Connect

## Overview

**Creative North Star: "The Gateway Logbook"**

The owner pages read like a logbook kept by the owner's own machine: what is waiting for a decision sits at the top, and below it is a plain stream of what happened, each line carrying its own action. The system is quiet and exact. Warm off-white ground, near-black teal ink, hairline rules instead of boxes, and colour reserved for state. It serves a developer who checks in briefly from a laptop or a phone over a remote link and needs to know in a second whether anything needs them.

Density is moderate and even: one 46rem column, rows separated by 1px rules, no cards in the feed. The only filled block on the console is the pinned request. Pages are server-rendered under a strict hash-pinned Content Security Policy with no external fonts, images or scripts, so the whole world is built from CSS, inline SVG and the system type stack. Every page works without JavaScript; one small script only adds Copy buttons.

The visual rejections are confirmed by the build and direction: no admin-settings scroll of equal-weight boxed sections, no status pills, no explanatory paragraph under every heading.

**Key Characteristics:**

- One centred column (46rem) on a warm grey ground, white paper only where a surface holds a decision.
- Rows on hairline rules; state shown by a small coloured dot plus a verb.
- Teal leads (actions, live state); orange means "waiting on you"; purple is focus; red is danger only.
- Monospace exclusively for exact machine values: origins, tool names, codes, keys, addresses.
- Motion is functional and slow: a breathing live dot and a draining time track, both stilled under reduced motion.

## Colors

A muted, teal-led palette on a warm grey ground, where each hue has exactly one job.

### Primary

- **Deep Harbour Teal** (`teal`): primary buttons, links, the selected access duration, the live and active dots, the remaining-time track, the current nav underline. Hover deepens to **Teal Ink** (`teal-ink`). **Teal Mist** (`teal-soft`) fills a selected profile option and the Copy button hover.

### Secondary

- **Kiln Orange** (`orange`): anything waiting on the owner: the pinned request's dot, a paused grant's dot, the first dot of the brand mark. Its tint family (`orange-soft` fill, `orange-line` border) belongs to the pinned request alone; **Burnt Umber** (`orange-ink`) colours the authenticator-off shield.

### Tertiary

- **Quiet Violet** (`purple`): the 3px focus outline on every focusable element, and the third dot of the brand mark. Nothing else.

### Semantic

- **Brick Red** (`danger`, with `danger-soft` hover fill and `danger-line` border): irreversible actions (Revoke, End session, Revoke all) and alerts. It is a danger state, never decoration.

### Neutral

- **Lichen Ground** (`ground`): page background, hover fill for secondary and quiet controls, the inset well behind schemas and the setup key.
- **Paper** (`paper`): the top bar, panels, inputs, options, the decide block.
- **Teal-Black Ink** (`ink`): body text and headings.
- **Slate Moss** (`muted`): meta lines, times, verbs, footer, inactive nav, ended rows.
- **Hairline** (`line`): every row rule and panel border.
- **Strong Hairline** (`line-strong`): input and option strokes, the ended-row ring dot, the segmented control's dividers.

### Named Rules

**The One Job Rule.** Each hue carries one meaning: teal is go and live, orange is waiting on you, purple is focus, red is irreversible. A hue never borrows another's meaning, and none is used as decoration.

**The Three Dots Rule.** The brand mark is three 0.6rem dots, orange, teal, purple, drawn from one element. The palette and mark are binding brand assets.

## Typography

**Display Font:** the system sans stack (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`)
**Body Font:** the same system sans stack
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`, ligatures off

**Character:** One sans on a fixed rem scale (base 16px, line height 1.5), weighted by fine variable steps (560, 620, 650, 680, 720) rather than size jumps. Headings are tight and slightly negatively tracked; monospace marks exact machine values so they can never be mistaken for prose.

### Hierarchy

- **Display** (720, 2rem, 1.2, -0.025em; 1.625rem under 600px): the consent question "Allow <app> to use your agent?".
- **Headline** (720, 1.75rem, 1.2, -0.025em; 1.5rem under 600px): page titles (Sign in, Security, Gateway, setup). Balanced wrap, breaks anywhere for long names.
- **Title** (680, 1.125rem, 1.3, -0.01em): section headings and fieldset legends; the pinned request's app name is the same weight at 1.25rem.
- **Body** (400, 1rem, 1.5): running text; feed sentences at 560 with the subject in bold and the verb at 500 in muted. Disclosure prose caps at 65ch.
- **Meta** (400, 0.875rem): one-line context under rows and in hints, always muted.
- **Label** (650, 0.8125rem): feed group headings (Now, Last 24 hours, Last 7 days, Earlier) and the time column; sentence case, never uppercase or letter-spaced.
- **Mono** (0.9375em inline; 1.1875rem in the consent origin chip; 1.25rem with 0.3em tracking in six-digit code inputs): origins, tool names, schemas, setup key, addresses.

### Named Rules

**The Exact Value Rule.** Monospace is reserved for values the owner must match character for character. An origin's scheme is shown in muted regular weight so the host stands out, but the full value always stays in the text.

**The Tabular Time Rule.** All times use tabular numerals; relative times are short (now, 5m, 3h, 2d) with the exact UTC time available on the element.

## Layout

A single centred column. The top bar and the console share a 46rem maximum width with 1rem side padding; form pages narrow to 28rem (sign-in, setup start, errors) or 38rem (authenticator scan). Compact and medium pages drop by a viewport-relative top padding (`clamp(2rem, 9vh, 4.5rem)` and `clamp(2rem, 7vh, 3.5rem)`); full pages start 2rem below the bar. The footer sits at the bottom of a full-height flex column.

The feed row is a four-column grid: time (3rem), dot (0.6rem), sentence, action, with a 0.9rem gap and 0.95rem vertical padding. Feed groups are separated by 1.75rem; page sections by 2.25rem. Spacing steps are rem-based: 0.25, 0.5, 0.75, 1, 1.25, 1.75, 2.25.

At 600px and below: the nav wraps to its own full-width line under the brand; the feed row drops its action column and the action moves under the sentence; the pinned request's Review button goes full width; row and form buttons go full width; the decision buttons stack with Approve on top; the duration control becomes two by two; the QR layout stacks with the phone-first "Open in authenticator app" button above the code. Every interactive target is at least 2.75rem (44px) tall on small viewports, and pages reflow at 320px.

### Named Rules

**The Row Carries Its Action Rule.** Every consequential action (Review, End session, Revoke) sits on the row it concerns. There is no separate management page for things already shown in the feed.

**The Rolling Window Rule.** Feed groups are rolling windows (Last 24 hours, Last 7 days, Earlier), never calendar days: a server-rendered page cannot know the owner's timezone. Live sessions sit above them under "Now".

## Elevation & Depth

Flat by default. Depth comes from the ground/paper contrast and 1px hairlines. The only resting shadow is a soft ambient lift under the standalone panel used for sign-in, setup and errors; the console, feed and consent page carry no shadows at all. Other `box-shadow` uses are structural, not elevation: the brand mark's extra dots, the nav's 2px inset underline, a selected option's inset ring, the radio's filled centre, the ended-row ring dot, and the live dot's breathing halo.

### Shadow Vocabulary

- **Panel lift** (`box-shadow: 0 1px 2px #202d2c0d, 0 12px 32px -18px #202d2c33`): standalone form panels only.
- **Live halo** (animated `0 0 0 0 #205e5866` to `0 0 0 .55rem #205e5800`, 2.6s, `cubic-bezier(.16,1,.3,1)`, infinite): the dot of a live session.

### Named Rules

**The One Filled Block Rule.** On the console, the pinned request is the only filled surface. Everything else is a line on the ground.

## Shapes

Gently rounded and consistent. Controls (buttons, inputs) use a 0.5rem radius; inset wells and the origin chip 0.45rem; options and alerts 0.65rem; the pinned request, panels and decide block 0.9rem (0.85rem). Dots and the radio are full circles. The remaining-time track is a 3px bar with a 2px radius, at most 14rem wide. Disclosure chevrons are drawn from two borders of a rotated square, turning from pointing right to pointing down on open. The current nav item squares off (radius 0) and takes a 2px teal underline.

## Components

### Buttons

Calm and solid; weight 650, minimum height 2.75rem.

- **Shape:** gently rounded (0.5rem).
- **Primary:** teal fill, white text, 0.6rem by 1.15rem padding. Approve, Review, Sign in, Continue, Turn on, Set up.
- **Hover / Focus:** hover deepens to teal ink (0.15s ease-out); active presses down 1px; focus is the 3px purple outline offset 2px.
- **Secondary:** paper fill with a strong-hairline stroke, ink text; hover fills with ground. Deny, Cancel.
- **Quiet:** transparent, muted text, 2.25rem tall (2.75rem and no side padding on phones). Row actions and Copy.
- **Danger:** red text on a quiet or secondary button, red-tinted border and hover fill. Only for irreversible actions; disabled danger falls back to muted on paper.

### Pinned Request (signature)

The only filled block on the console: orange tint fill, orange hairline, 0.9rem radius, a grid of orange dot, text and Review button. The app name sits at title weight 1.25rem followed by "wants to use your agent" in muted 500; the exact origin follows in mono, then tool count and expiry in a warm muted meta line.

### Feed Rows (signature)

Time, dot, sentence, action on a hairline. Dot states: teal for active and live, breathing teal for live sessions, orange for paused, a hollow strong-hairline ring for revoked, expired and ended. The sentence is the subject (declared app name in bold, or the origin when no name was stored) plus a muted verb (is connected, approved, revoked, expired). When a name leads, the exact origin opens the meta line. An active grant shows a thin teal track that drains linearly over the remaining seconds via per-row CSS (`--from` and `animation-duration`), no script. Tools sit behind a "Show N tools" disclosure.

### Cards / Containers

- **Corner Style:** 0.9rem.
- **Background:** paper.
- **Shadow Strategy:** panel lift only for standalone form panels (see Elevation & Depth).
- **Border:** 1px hairline.
- **Internal Padding:** 1.75rem (1.25rem on phones).

### Inputs / Fields

- **Style:** paper fill, 1px strong-hairline stroke, 0.5rem radius, 3rem minimum height, label above at weight 620 with a 0.4rem gap.
- **Focus:** hover strengthens the stroke to muted; focus is the global purple outline.
- **Code input:** mono, 1.25rem, 0.3em tracking, tabular, at most 11rem wide.

### Choice Controls

- **Segmented duration:** four equal cells joined by 1px strong-hairline gaps inside one 0.55rem-radius frame; the checked cell fills teal with white text; focus draws the purple outline inset.
- **Profile options:** full-width paper cards (0.65rem radius) with a custom radio; the checked option takes a teal-mist fill, teal stroke doubled by an inset ring, and a teal-filled radio.

### Disclosures and Exact Values

Tool rows show the tool name in bold mono over a one-line description; the input schema opens into a 0.8125rem mono well on ground (max 22rem tall, scrollable, focusable). The consent origin sits in an origin chip: paper, strong-hairline stroke, 0.45rem radius, mono 600. Addresses and the setup key are selectable in one gesture; the key is grouped in fours.

### Navigation

A white top bar with a hairline under it. Brand mark and name at left (weight 720); Activity, Security, Gateway as muted 600 links with 2.75rem targets, hover fills ground, the current page is ink with a 2px teal inset underline; Sign out as a quiet button. On phones the links wrap to a full-width row under the brand.

### Alerts and Setup Prompt

Alerts are a red-tinted block with a red hairline and 0.65rem radius, bold first line, plain repair text with gateway commands set as code. The missing-authenticator prompt is a single line under the bar: orange-ink shield icon, one sentence, one link, on a bottom hairline; it is not a banner.

### Copy (progressive enhancement)

A single hash-pinned script copies the authenticator key and gateway addresses. Without it, Copy buttons stay hidden (`hidden` attribute) and the values stay selectable. Status text ("Copied") fades in over 0.8s and clears after 3s.

## Do's and Don'ts

### Do:

- **Do** show state with a 0.6rem dot plus a verb (Approved, Live, Revoked, Expired).
- **Do** put the action on the row it concerns, as a quiet button at the row's end (under the sentence on phones).
- **Do** set origins, tool names, codes, keys and addresses in monospace with ligatures off, and keep the full exact value in the text.
- **Do** use red only for irreversible actions and alerts.
- **Do** keep every flow working as plain forms and links; enhancements must leave the page whole when they do not run.
- **Do** keep 3px purple focus outlines, 2.75rem targets under 600px and 320px reflow.
- **Do** still motion under `prefers-reduced-motion`: no transitions, no breathing dot, no draining track, no copy fade.
- **Do** record only stored facts in the feed: grants keep approval and revocation times and the app's declared name; ended sessions are not retained, so only live sessions appear.

### Don't:

- **Don't** use pills or badges for state.
- **Don't** box feed rows into cards; the pinned request is the only filled block on the console.
- **Don't** group the feed by calendar day.
- **Don't** use red, orange or purple decoratively; outside the brand mark, each appears only in its one job.
- **Don't** add explanatory paragraphs under every heading, or eyebrow labels above them; say a thing once, where it is needed.
- **Don't** load external fonts, images or scripts; the pages run under a hash-pinned CSP.
