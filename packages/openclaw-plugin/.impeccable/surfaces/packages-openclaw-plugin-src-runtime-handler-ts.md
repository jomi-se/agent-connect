---
version: 1
slug: "packages-openclaw-plugin-src-runtime-handler-ts"
primary_target: "packages/openclaw-plugin/src/runtime/handler.ts"
related_targets: ["packages/gateway/src/openclaw-plugin/consent-html.ts"]
---

Scope: owner authentication, OAuth consent, and the direct owner console. Mode: Operate.

Audience and job: a self-hosting owner often arrives on a phone from an application authorization request. They must authenticate, understand the exact requested authority, approve or cancel, and later inspect or revoke access without learning OpenClaw configuration.

THESIS: Agent Connect behaves like one familiar identity-provider plate whose stable identity, width, reading order, and action placement survive every step. It refuses both the raw utility form and the decorative security dashboard.

OWN-WORLD: A quiet cool-neutral work surface holds one crisp white authorization plate with workbench-ink text and primary actions. The shared Canvas wordmark uses three circles—application coral, gateway teal, and agent periwinkle—while teal identifies the authorization boundary and periwinkle carries focus. Fine rules, restrained 14px corners, and workhorse humanist typography keep the surface familiar. Status color appears only with text and icon-independent wording.

STORY: The requesting application is named before owner authentication. The same shell then reveals bounded application tools and native capabilities, preserves an obvious cancel path, and returns the owner to an operational console where active access precedes profile details.

FIRST VIEWPORT: On phone and desktop, the Agent Connect wordmark and requesting application anchor the top of a centered plate. The current task occupies the middle; recovery guidance and a stable action row close it. The plate becomes full-width within the phone gutter without changing its order.

FORM: User-pinned modern IdP authorization plate, chosen over the rolled alternatives after seed fdc32422. Code-led; familiarity is topology and interaction grammar, never a security claim or a vendor clone.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Boundaries: preserve enrollment verification, owner cookie, exact redirect allowlisting, same-origin checks, one-use CSRF, policy fingerprinting, durable grant writes, no-store responses, and separation of application tools from native capabilities. Profile management is read-only in this release; no last-use claim is shown.
