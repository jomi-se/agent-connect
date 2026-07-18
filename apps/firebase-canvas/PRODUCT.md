# Product

## Register

product

## Platform

web

## Users

The primary audience is an OpenAI Build Week judge evaluating Agent Connect from a desktop or mobile browser. They need to understand the project's value quickly, verify the live application-to-agent tool flow, see that the client-side integration is small, and recognize the robustness and security work supporting it.

The longer-term audience represented by the demo is a web developer who wants to add agent-powered features while allowing each user to bring an agent they already own, such as Codex or Claude Code.

## Product Purpose

The demo is both a working application and an explanation of Agent Connect. A visitor authorizes the page, sends a task to a remote user-owned agent, and watches that agent invoke a tool defined live by the web application. The surrounding interface makes the authorization, prompt delivery, tool request, local execution, and result return visible as they happen.

After the live proof, practical code and terminal examples show how a developer would declare application tools, connect through the browser SDK, operate the gateway, and expose the connector through a supported transport. Success means a judge can experience the result, understand the architecture and security boundaries, and see how little application code is required.

## Positioning

Any web app can safely lend temporary tools to a user-owned agent, without installing those tools into the agent beforehand.

## Brand Personality

Effortless, trustworthy, and refined. The client integration should feel immediately approachable, the security model should be visible rather than hand-waved, and the presentation should feel elegant and technically compelling without using futuristic or science-fiction theatrics.

## Anti-references

Do not resemble a futuristic science-fiction AI interface, a generic gradient-heavy AI startup landing page, a terminal-first hacker demo that excludes web developers, or a dense enterprise-security dashboard that makes the integration feel intimidating.

## Design Principles

1. Lead with working proof. Let the visitor run the agent-connected interaction before asking them to absorb the architecture.
2. Make the invisible flow visible. Reflect authorization, agent work, tool invocation, browser execution, and completion in the interface as they occur.
3. Keep simple things simple and serious things legible. Show the tiny browser integration first, then progressively reveal the connector, transport, orchestration, and security boundaries behind it.
4. Explain with real artifacts. Prefer the actual runtime state, tool events, SDK snippets, and operator commands over abstract claims.
5. Treat mobile as a first-class demonstration surface. The complete flow must remain understandable and operable from a phone.

## Accessibility & Inclusion

Target WCAG 2.2 AA for this public demo. Support keyboard navigation, strong visible focus states, reduced-motion preferences, sufficient color contrast, and touch-friendly controls and layouts on mobile.
