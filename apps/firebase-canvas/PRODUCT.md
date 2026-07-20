# Product

## Register

product

## Platform

web

## Users

The primary audience is an OpenAI Build Week judge evaluating Agent Connect from a desktop or mobile browser. They need to understand the project's value quickly, verify the live application-to-agent tool flow, see that the client-side integration is small, and recognize the robustness and security work supporting it.

The longer-term audience represented by the demo is a web developer who wants to add agent-powered features while allowing each user to bring an agent they already own, such as Codex or Claude Code.

## Product Purpose

The demo is both a working application and an explanation of Agent Connect. A visitor authorizes the page once, chooses a project-board, document-review, or product-research feature, and watches a connected runtime invoke tools defined live by the web application. The surrounding interface makes the authorization, prompt delivery, tool requests, local execution, and result return visible as they happen.

The mobile and desktop versions are separate compositions over the same demo behavior. Mobile presents a linear touch-first connection and task flow, then progressively discloses technical detail. Desktop keeps the scenarios, execution path, responsibility boundary, and browser code visible together. Success means a judge can experience three credible app-native features, understand the SDK/gateway split and security boundary, and see how little application code is required.

## Positioning

Web developers can build AI features powered by coding agents their users already own. The app defines the actions; the user-owned gateway controls access to Codex, Claude Code, or another compatible runtime.

## Brand Personality

Effortless, trustworthy, and refined. The client integration should feel immediately approachable, the security model should be visible rather than hand-waved, and the presentation should feel elegant and technically compelling without using futuristic or science-fiction theatrics.

## Anti-references

Do not resemble a futuristic science-fiction AI interface, a generic gradient-heavy AI startup landing page, a terminal-first hacker demo that excludes web developers, or a dense enterprise-security dashboard that makes the integration feel intimidating.

## Design Principles

1. Lead with working proof. Let the visitor run the agent-connected interaction before asking them to absorb the architecture.
2. Make the invisible flow visible. Reflect authorization, agent work, tool invocation, browser execution, and completion in the interface as they occur.
3. Keep simple things simple and serious things legible. Show the tiny browser integration first, then progressively reveal the gateway, transport, orchestration, and security boundaries behind it.
4. Explain with real artifacts. Prefer the actual runtime state, tool events, SDK snippets, and operator commands over abstract claims.
5. Treat mobile as a first-class demonstration surface. The complete flow must remain understandable and operable from a phone.
6. Share behavior, not layout. Mobile and desktop use the same authorization and tool controller but may use different hierarchy, copy density, and disclosure patterns.

## Accessibility & Inclusion

Target WCAG 2.2 AA for this public demo. Support keyboard navigation, strong visible focus states, reduced-motion preferences, sufficient color contrast, and touch-friendly controls and layouts on mobile.
