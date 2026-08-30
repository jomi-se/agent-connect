# Future task: application identity for native clients

Status: proposed, not started. Written 2026-08-30 while planning a Readest fork
as the first Agent Connect consumer that is not a web page. Synthesizes a
GPT-5 research pass with local verification against the Readest source tree
and this repository's own history.

## The gap

Every authorization path in Agent Connect today derives the application's
identity from the browser's `Origin` header. That header is doing five jobs at
once, and it does all of them well:

1. **Namespace.** `https://example.app` is globally unique, controlled through
   DNS and TLS.
2. **Consent label.** The gateway can display "example.app is asking to use your
   agent subscription" and the sentence is true.
3. **Callback routing.** The authorization code returns to that same origin
   (`connector-auth.ts:685-699` requires `redirect.origin === origin` over
   HTTPS).
4. **Confinement.** Page JavaScript cannot forge `Origin`, so another origin
   cannot quietly use the grant.
5. **Enrollment.** The gateway can accept an origin it has never seen, because
   the browser asserts the identity and the network proves control of the
   domain (`isDynamicApplicationOrigin`, `gateway.ts:661`).

A Tauri Android WebView reports `http://tauri.localhost`. Not HTTPS, not unique
— every Tauri app on earth shares it — and there is no page to redirect back to.
All five jobs fail at once.

The runtime leg is already solved. ADR 0009's **standard-client profile**
accepts a request with no `Origin` header when the transport principal is
present, the session capability is valid, and the grant carries the
`non_browser_clients` consent bit. Readest confirms the transport exists:
`@tauri-apps/plugin-http` issues requests from Rust with no `Origin`, no
preflight, and no cleartext block, and Readest already routes every AI provider
call through it (`src/services/ai/utils/httpFetch.ts:14`).

What is missing is the **authorization** leg: how a native application
establishes an identity worth naming on a consent page, and how it receives an
authorization response.

## Android splits what the origin fused

The mistake to avoid is manufacturing an Android-flavoured `Origin`. Native
platforms deliberately separate the concerns the web bundles:

| Question | Android mechanism |
| --- | --- |
| What application product is this? | Public OAuth `client_id`, package name, or publisher metadata URL |
| Who publishes it? | Domain ownership, store listing, signed metadata, attestation |
| Which installed copy is this? | Per-installation asymmetric key |
| Where does the authorization response go? | Verified Android App Link |
| Who started this transaction? | PKCE, `state`, `nonce`, or a pairing code |
| Who is making later calls? | Key-bound capability, or DPoP |
| Is this the official binary? | Optional Play Integrity or another attestation |

RFC 8252 treats hybrid applications as native clients regardless of the WebView
UI: public client, no bundled secret, PKCE required, system browser or Custom
Tab rather than an in-app WebView, HTTPS claimed redirect where the platform
supports one. A custom scheme like `readest://callback` is weaker, because any
installed application can register the same scheme.

## Three application profiles

The proposal is to name three profiles that all mint the **same internal grant**
— client subject, installation key thumbprint, tool snapshot hash, chosen
runtime, authorization profile, issue and expiry, revocation state — so nothing
downstream of authorization has to care which one was used.

**`browser_origin`** — today's behaviour. Identity is the HTTPS origin, the
callback is same-origin HTTPS, runtime requests carry `Origin`.

**`native_published`** — for store-distributed builds. Identity is an HTTPS
client-metadata URL, the callback is a verified App Link, the transaction runs
in the system browser with PKCE, and runtime requests are key-bound with no
`Origin`.

**`native_paired`** — for forks, development builds, sideloaded and F-Droid
builds, and anything with no domain. Identity is a user-approved installation,
authorization happens through device-code pairing, and no callback is needed.

## Candidate mechanisms

| Approach | Protocol change | Domain required | Serves forks | Publisher identity |
| --- | --- | --- | --- | --- |
| Hosted connect page | none | yes | poor | domain-level |
| Pre-registered native client | moderate | usually | poor | strong if curated |
| Client-metadata URL + App Link | moderate | yes | yes, per publisher | good |
| Device-code pairing | new endpoint | no | excellent | optional |

**Hosted connect page.** The app opens `https://connect.<domain>` in a Custom
Tab; that page is a real browser at a real origin, so authorization proceeds
unchanged; the callback returns to the same domain and Android routes it into
the signed app by App Link. Works with today's protocol. But every fork needs a
domain, debug builds are awkward, the consent page names the bridge rather than
the installation, and a public page must reach a possibly tailnet-only gateway
— CORS and private-network-access behaviour need verifying.

**Pre-registered native clients.** How centralized OAuth works, and a poor fit
here: every self-hosted gateway operator would have to register Readest, each
fork, and each debug signing identity. RFC 7591 dynamic registration with signed
software statements automates it, but then Agent Connect needs a trust model for
statement issuers. Reasonable for an enterprise gateway; absurd for a user
connecting their own reader to their own agent.

**Client-ID metadata document.** An emerging OAuth draft
(`draft-parecki-oauth-client-id-metadata-document`) where the `client_id` *is*
an HTTPS URL the authorization server fetches for name, logo, redirect URIs, and
client type. It recovers the useful half of an origin — a publisher controlling
an HTTPS namespace — without requiring the application to execute there, and it
was designed for clients with no prior registration. Still a draft; adopting it
is a deliberate experiment. Best long-term fit for a published build.

**Device-code pairing.** Shaped like RFC 8628. The app generates a per-gateway
key, sends its public key plus self-reported metadata and the tool snapshot, and
receives a high-entropy device code plus a short user code. It shows the short
code and opens the gateway's consent page. The gateway displays the application
name, verified publisher information *or an explicit unverified label*, the
device nickname and key fingerprint, the same short code, and the full tool
snapshot. The user approves; the app polls, proving possession of its
installation key; the grant is bound to that key and hash.

## Recommendation

`native_paired` is the strategically correct answer for Agent Connect, with the
hosted connect page as a tactical bridge and `native_published` as the polish
layer for a store build.

The reasoning is specific to what Agent Connect is. A gateway is user-owned,
often self-hosted, frequently reached only over a tailnet, and will meet
applications no registry has ever heard of — forks, local builds, an F-Droid
APK, a phone with no Google services. Pairing is the only mechanism on the list
that needs no domain, no store account, no production signing setup, and no
central registry, and it generalizes unchanged to desktop apps and CLIs.

It also reframes the question honestly. Instead of "how can a native app pretend
to have a web origin", it asks "how does a user deliberately pair this
installation with their gateway, and what verified publisher information can we
add when it happens to be available".

## What this repository already contains

Pairing is not a new idea here, and the history matters.

**ADR 0004** shipped a pairing-code flow: the gateway emitted a short-lived
single-use code through its local terminal, an application submitted it with an
app id and fixed tool snapshot, and the gateway bound the resulting capability
to origin, app id, session id, and tool hash. It was superseded by ADR 0007 and
the implementation removed on 2026-07-22. Its own security note is still the
right framing: *"Pairing proves possession of a secret delivered through a
user-controlled local channel; it does not prove a civil identity."*

It was superseded because gateway-hosted OAuth is a better fit for **browser**
applications, not because pairing was wrong. Reintroducing it for native clients
is a return to a known shape for the case where the browser cannot supply an
identity — but the gap ADR 0004 left unresolved must not return with it: it
authenticated the application to the gateway without authenticating an arbitrary
first-contact destination to the application. ADR 0005's transport profiles and
ADR 0007's runtime card exist to close exactly that, and a native pairing flow
must sit on top of both rather than beside them.

`docs/research/2026-07-14-mutual-runtime-identity.md` already records the target
shape: enroll the gateway key through an account-backed device flow, Tailscale
identity, or direct QR/fingerprint transfer; treat URLs as routing hints; bind
later application capabilities to both gateway and client keys.

## Hazards to design against

**The consent page must keep saying something true.** The origin profile's
strength is that "example.app is asking" is verified. A paired client
self-reports its name, so the page must distinguish *verified publisher* from
*self-reported*, visibly, and a paired client must never be able to render as a
known origin. Namespace the display identity so a self-reported name cannot
collide with or impersonate an enrolled web origin.

**The transport boundary does real work here.** A public device-code endpoint is
a phishing and guessing surface; RFC 8628 spends most of its security section on
it. On a tailnet-only gateway the pairing endpoint is reachable only from the
user's own devices, which is a materially stronger position than the flows the
RFC was written for. That is a reason to require a transport principal for
pairing, not a reason to relax the usual protections — user-initiated only,
matching code shown on both surfaces, short expiry, strict rate limiting.

**Installation keys, one per gateway.** A single global device key would let
unrelated gateways correlate the same device. Never use IMEI, Android ID,
advertising ID, or any other persistent hardware identifier. The key belongs in
Android Keystore, non-exportable, with the public thumbprint as the installation
identifier. Where Agent Connect's existing transport principal already proves
possession of such a key, reuse it rather than layering DPoP; DPoP (RFC 9449) is
the standard fallback for binding tokens to a client key, but it proves
possession, not application identity.

**Lifecycle falls out of the binding, and it is good.** Upgrading the app keeps
the grant; reinstalling produces a new identity and re-pairs; revoking one phone
leaves other installations alone; a copied bearer token is useless without the
key; and a changed tool snapshot still forces visible reauthorization.

**Keep the key behind the native boundary.** Grants, the installation key, and
request signing must live in Rust behind a narrow command surface, unreachable
from WebView storage and from any rendered artifact. This matters more than
usual for the Readest work, where the agent is expected to emit rich HTML: a
sandboxed artifact that finds a WebView bug must not be able to reach a reusable
gateway credential.

**Do not build on Play Integrity.** It is a useful anti-abuse signal for a Play
build and nothing else: it couples the protocol to Google Play, penalizes
F-Droid and sideloaded and locally compiled builds, needs Cloud configuration
and server-side verification, and carries quota and availability dependencies.
Device integrity is not a prerequisite for a user authorizing their own
installed application. If high assurance is ever needed, the IETF
attestation-based client authentication draft is the right abstraction, and it
is excessive for this stage.

**Reachability is not identity.** None of these profiles answers how a phone
reaches a tailnet-only gateway in the first place. That is
`docs/future/hassle-free-tunnel-ingress.md`, and it gates the native work as
firmly as identity does.

## Evidence from the Readest tree

Verified locally in `apps/readest-app/src-tauri` on 2026-08-30, because it
determines what a fork inherits:

- `identifier` is `com.bilingify.readest`.
- `plugins.deep-link.mobile` declares `{scheme: ["https"], host:
  "web.readest.com", appLink: true}`, and the generated manifest carries
  `android:autoVerify="true"` for that host.
- Three custom schemes also exist (`readest`, `readest-onedrive`, and a
  reverse-DNS Google client id), used by the existing OAuth path.

So the official application already has the hard half of `native_published`: a
verified domain-to-signed-package association. What it does not have is any
client-metadata document, which is unsurprising — Agent Connect published
`0.0.1` on 2026-08-28.

A fork inherits none of it. Android matches the *signing certificate*, not the
package name, so a fork-signed build is not the application associated with
`web.readest.com`; that is the mechanism working correctly. A fork wanting
`native_published` needs its own package id, release signing certificate,
domain, `assetlinks.json`, App Link declaration, and callback path. Which is
precisely the argument for `native_paired`: a locally compiled fork should not
need a domain, a store account, and production signing to talk to its owner's
gateway.

## Sequencing

1. **Web build first.** The Readest PoC proves the product — local RAG, book
   tools, citations, tutor quality, streaming, rich artifacts — entirely within
   `browser_origin`, with no identity work at all.
2. **Hosted connect page** for a first Android demonstration. No protocol
   change; exercises ADR 0009's standard-client profile end to end.
3. **`native_paired`** as the real native profile, reusing ADR 0004's lessons
   and ADR 0005's transport profiles.
4. **`native_published`** with a client-metadata document and App Links, when
   there is a published build to justify it.
5. **Attestation** optional, never foundational.

## Open questions

- Where does the pairing endpoint live relative to the authorization server in
  ADR 0007's runtime card, and does the card need a field advertising which
  application profiles a gateway supports?
- Does `native_paired` reuse the `non_browser_clients` consent bit, or does a
  paired grant imply it and make the checkbox browser-only?
- How is a paired installation named in the gateway's grant list, and how does
  the user tell two installations of the same fork apart at revocation time?
- Should the tool snapshot be sent at pairing initiation, or fetched by the
  gateway from the client afterwards, given the hash must match what the consent
  page displayed?
- Can the hosted connect page reach a tailnet-only gateway at all, or does the
  bridge implicitly require the public ingress from
  `hassle-free-tunnel-ingress.md`?

## References

- RFC 8252, OAuth 2.0 for Native Apps
- RFC 8628, OAuth 2.0 Device Authorization Grant
- RFC 7591, OAuth 2.0 Dynamic Client Registration
- RFC 9449, OAuth 2.0 Demonstrating Proof of Possession (DPoP)
- `draft-parecki-oauth-client-id-metadata-document`
- Android App Links verification and Digital Asset Links
- ADR 0004 (superseded), ADR 0005, ADR 0007, ADR 0009
- `docs/research/2026-07-14-mutual-runtime-identity.md`
- `docs/future/hassle-free-tunnel-ingress.md`
