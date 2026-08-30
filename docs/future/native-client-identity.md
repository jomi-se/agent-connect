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
2. ~~**Hosted connect page** for a first Android demonstration.~~ **Discarded**
   2026-08-30 — see "The hosted bridge is discarded" below. It collides with
   Local Network Access, and it misrepresents a native client as a
   browser-origin one. Go straight to pairing.
3. **`native_paired`** as the real native profile, reusing ADR 0004's lessons
   and ADR 0005's transport profiles.
4. **`native_published`** with a client-metadata document and App Links, when
   there is a published build to justify it. For an upstream Readest
   integration this becomes the *normal* path and pairing the fallback.
5. **Attestation** optional, never foundational.

## Resolved: how the five open questions were answered

Answered 2026-08-30. Three requirements sit above all five and are not
negotiable:

1. The application verifies the runtime card and establishes the expected
   transport principal **before** submitting any pairing material. Pairing
   authorizes an application installation; it must never recreate ADR 0004's
   gap, where the application knew only that *something* answered at the
   configured endpoint.
2. The gateway renders verified and self-reported identities in **visibly
   different namespaces**.
3. Pairing authorizes a specific **installation key and tool snapshot**, not an
   application name.

### 1. Profiles are advertised through authorization-server metadata

Not through the runtime card. The card answers "who is this runtime, where is
it, how do I authenticate its transport identity" and should stay a small,
stable, signed bootstrap object. Which authorization methods exist is a
different question, and the card already carries `authorizationServer` to point
at whatever answers it:

```json
{
  "issuer": "https://gateway.example/authorization",
  "agent_connect_client_profiles_supported": ["browser_origin", "native_paired"],
  "authorization_endpoint": "https://gateway.example/authorize",
  "native_pairing_endpoint": "https://gateway.example/native/pair"
}
```

A gateway that publishes no metadata means "browser profile only", so old
gateways degrade correctly and clients never probe endpoints and interpret
404s. Same separation as OAuth Authorization Server Metadata, without owing
every field of it. **Card version 2 is therefore not assumed** — it becomes
justified only if `authorizationServer` cannot serve as a discovery root, or
the current parser rejects unknown fields. That is an implementation finding,
not a starting premise.

Clients negotiate:

```ts
if (gateway.supports('native_published') && app.hasPublishedIdentity) {
  authorizeAsPublishedClient();
} else if (gateway.supports('native_paired')) {
  pairInstallation();
} else {
  showUnsupportedGateway();
}
```

### 2. A paired grant is originless by definition; no checkbox

A native application cannot present a meaningful browser origin, so asking the
user to permit originless use is a question with one correct answer. The consent
page states it as fact: *"This is a paired native application. It will connect
directly from this device rather than through a browser origin."*

Go further than auto-setting the existing boolean: make the **profile
authoritative** in the policy engine.

```ts
type AuthorizedClient =
  | { profile: 'browser_origin';   origin: string; allowOriginlessRuntime: boolean }
  | { profile: 'native_paired';    instanceKeyThumbprint: string }
  | { profile: 'native_published'; clientId: string; instanceKeyThumbprint: string };
```

A free-floating `non_browser_clients` boolean permits nonsensical states because
it conflates two different things: a browser-origin grant *exceptionally
extended* to originless use, and a grant *intrinsically* originless. Persist
`{"client_profile": "native_paired", "non_browser_clients": true}` for
compatibility if useful, but read the profile. The boolean becomes a legacy
property of `browser_origin` grants.

### 3. The gateway owns the installation nickname; the app only suggests it

The application proposes `{suggested_device_name, platform, app_version}` as
self-reported hints. The consent page lets the user confirm or edit, so the
durable management label is gateway-owned and the application cannot silently
rename itself later.

```
Application
  Readest Book Helper
  Publisher: Unverified local application

Device
  Suggested name: Readest on Pixel 7
  Name this installation: [ José's Pixel 7            ]

Pairing fingerprint
  amber-river-cobalt-lantern
```

```ts
interface PairedInstallation {
  grantId: string;
  instanceKeyThumbprint: string;   // security identity
  transportPrincipal: string;
  nickname: string;                // user-managed identity
  platform?: string;               // self-reported, informational
  deviceModel?: string;
  appVersionAtPairing?: string;
  pairedAt: string;
  lastUsedAt?: string;
}
```

A raw SHA-256 thumbprint is fine in logs and useless to humans: derive a short
authentication string (four or five words, or grouped hex) and show the same one
in the application and on the consent page. It is a comparison aid; the
thumbprint remains the identifier. Note the two codes do different jobs — the
**pairing code** identifies a short-lived transaction, the **key fingerprint**
identifies the durable installation.

Also required: a separate installation key per gateway; never a hardware
identifier; rename from the gateway UI; "revoke this installation" and "revoke
all installations of this client"; and on reinstall or lost key, a new pairing
rather than heuristic recovery.

### 4. The full tool snapshot is pinned at pairing initiation

The client submits complete tool definitions — not a claimed hash. The gateway
validates size and schema, canonicalizes, hashes, and stores them. The consent
page renders **only the gateway's stored copy**, and the grant receives exactly
that stored hash. The pairing transaction is immutable once created; a client
whose tools change mid-pairing cancels and restarts.

```
submitted snapshot = displayed snapshot = approved snapshot = grant-bound hash
```

```ts
interface PendingNativePairing {
  deviceCodeHash: string;
  userCodeHash: string;
  transportPrincipal: string;
  instancePublicKey: JsonWebKey;
  instanceKeyThumbprint: string;
  clientIdentity: ClientIdentityClaim;
  canonicalToolSnapshot: CanonicalToolDefinition[];
  toolSnapshotHash: string;
  suggestedDeviceName?: string;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
}
```

Expired, denied, and completed pairings are single-use; repeated redemption is
idempotent or returns a terminal "already consumed" rather than minting a second
grant.

**Later tool changes must not repeat the whole ceremony.** The installation is
already known and its key proves which client is asking, so an
authorization-update flow shows a semantic diff and asks only for approval:

```
Added:    render_artifact — Render agent-authored interactive HTML
Changed:  remember — May now store categorized memories
Removed:  summarize_selection
```

That is what "we do not freeze tools, we make reauthorization painless but
apparent" means in practice.

### 5. The hosted bridge is discarded

Chrome gates requests from public pages to local-network addresses behind a
Local Network Access permission prompt (Chrome 141; extended to WebSockets in
147), and Chromium classifies Tailscale's `100.64.0.0/10` as local for this
purpose. A hosted bridge would therefore need *all* of: the device on the right
tailnet, MagicDNS resolving, valid gateway HTTPS, the bridge itself a secure
context, the user granting the local-network permission, gateway CORS admitting
the bridge origin, preflight succeeding, SSE surviving, and the user's browser
implementing compatible LNA behaviour. Not impossible; simply not the "open a
page and it works" path it was proposed to be, and it also misrepresents a
native client as a browser-origin client.

**The decisive detail: Chrome does not apply LNA restrictions to top-level
main-frame navigation.** So opening the gateway's own consent page in a Custom
Tab is materially safer than a public page fetching the gateway as a
subresource. Pairing gets this for free:

```
Native app → top-level Custom Tab navigation → tailnet gateway consent page
```

No public-origin JavaScript ever treats the gateway as a subresource.

## Measured locally, 2026-08-30

Probed against a live gateway with a Chrome 152 automation browser.

**The gateway refuses non-HTTPS origins at the preflight.** An `http://` origin
gets `403 origin_not_allowed` on the `OPTIONS` itself, both directly and through
Tailscale Serve, consistent with `isDynamicApplicationOrigin` requiring HTTPS.
An HTTPS origin gets a reflected preflight:

```
OPTIONS /v1/responses   Origin: https://connect.example.com
-> 204  Access-Control-Allow-Origin: https://connect.example.com
        Access-Control-Allow-Methods: GET, POST, OPTIONS
        Access-Control-Allow-Headers: Authorization, Content-Type
```

No `Access-Control-Allow-Private-Network` is sent. Consequence beyond Android:
an application served from `http://localhost:5173` in development cannot call
the gateway from the browser at all. Only an HTTPS origin can.

Address-space behaviour, serving pages from three address spaces on one host:

| Initiator | Target | Result |
| --- | --- | --- |
| `http://100.101.140.78:9099` (tailnet) | `http://10.0.0.194:9098` | ordinary preflight, succeeded |
| `http://100.101.140.78:9099` (tailnet) | `http://127.0.0.1:9098` | never reached the server, hung pending |
| `http://127.0.0.1:9099` (loopback) | `http://10.0.0.194:9098` | never reached the server, hung pending |
| `http://127.0.0.1:9099` (loopback) | `https://…ts.net:8443/v1/responses` | reached the gateway in 25 ms, refused by its own origin policy |

The hangs are a permission gate rather than unreachability — the same browser
loads pages from both addresses directly, and a policy-blocked request fails
fast; automation cannot answer a prompt, so the request waits.

**This does not measure the scenario that matters**, and should not be read as
if it did. None of these initiators is a public origin, which is the only
initiator LNA gates. Row four is a cross-space request that was *not* gated,
which is consistent with the initiator being loopback rather than public. Rows
two and three remain unexplained by that model and may be automation artefacts.
This host cannot serve a page from a public IP: Funnel needs root here (`serve
config denied`, no `--operator` set) and would not settle it anyway, since
MagicDNS resolves the funnel hostname to the tailnet address for any device on
the tailnet — a browser on the tailnet would load the "public" page over a
private address and never make the crossing being tested.

The operator separately recalls a system-style permission prompt while testing a
locally served application against this gateway, which is what the Chrome 141
behaviour predicts.

**The experiment that settles it** — worth running even though the bridge is
discarded, because it establishes exact behaviour on the target stack. From a
public HTTPS page, against `https://<gateway>.<tailnet>.ts.net`: a simple GET, a
preflighted POST, SSE streaming, and cancellation; across Chrome Android, Chrome
desktop, and Firefox Android; with permission granted and denied; with Tailscale
disconnected; with tailnet DNS unavailable; against a raw `100.x` address versus
the `ts.net` name; and top-level navigation as the control. Record whether a
prompt appears, the exact request and response headers, whether the preflight
carries any local-network header, the console error, whether the gateway
received anything, whether SSE stays open, and what happens after the permission
is revoked.

## Publisher verification is a separate dimension from profile

The three profiles describe **how authorization happened**. They do not describe
**who the publisher is**, and collapsing the two produces exactly the
impersonation the consent page must prevent.

```ts
type ClientProfile = 'browser_origin' | 'native_paired' | 'native_published';

type PublisherVerification =
  | { kind: 'origin';        origin: string }
  | { kind: 'https_metadata'; clientId: string }
  | { kind: 'attested';       issuer: string; subject: string }
  | { kind: 'none' };
```

A paired client may carry verified publisher metadata; a local fork carries
none. The consent page must never render `web.readest.com wants access` because
a paired application submitted `{"name": "web.readest.com"}`. Instead:

```
Unverified paired application
Self-reported name: web.readest.com
Publisher: Not verified
```

against a verified client's:

```
Readest
Verified publisher: web.readest.com
Paired installation: José's Pixel 7
```

Origin-shaped display names are reserved to the verified namespace, and names,
logos, and favicons are never loaded as trusted UI from self-reported pairing
data.

**A metadata URL alone proves nothing about the running binary.** Fetching
`https://web.readest.com/.well-known/agent-connect-client.json` proves only that
whoever controls that domain published that document — a malicious fork can
submit the same URL. Binding the *running application* to that publisher needs
the verified App Link flow, a platform attestation bound to the installation
key, or a publisher-issued client attestation.

Note what the metadata document is *not*: it is a server-side HTTPS fetch by the
gateway of a static public document. No hosted JavaScript talks to the gateway,
no public bridge handles authorization, and no browser fetch crosses into the
tailnet. That is why discarding the bridge does not discard the metadata
document.

## Product matrix

| Application | Preferred profile | Fallback |
| --- | --- | --- |
| Readest web | `browser_origin` | none |
| Official Readest Android/iOS | `native_published` | `native_paired` |
| A signed fork with its own domain | `native_published` | `native_paired` |
| Local or debug fork | `native_paired` | none |
| CLI or desktop harness | `native_paired` | a published profile later |

For an upstream Readest integration, `native_published` is the normal path and
pairing is the fallback — the official application already owns the hard half
(verified `web.readest.com` to `com.bilingify.readest` association), and the
flow costs the user one consent screen with no visible code or polling:

```
Readest Android
  → native authorization request (profile: native_published, client_id = metadata URL)
  → gateway fetches metadata, verifies the callback appears in it
  → gateway displays verified publisher identity and the pinned tools
  → user approves
  → redirect to the declared web.readest.com callback
  → Android App Link opens the officially signed Readest
  → Readest redeems with PKCE + installation key
```

A malicious fork can claim the same client id but cannot receive the callback:
Android delivers it to the officially signed application, and PKCE stops either
side redeeming the other's code.

Pairing keeps its friction *on purpose* — with no publisher-established
callback, the user is manually establishing the trust relationship the platform
cannot.

The resulting state machine is pleasantly small:

```
verified runtime → pending pairing with pinned tools → user-approved
installation → key-bound grant → runtime session
```

which sits directly on ADR 0005 and ADR 0007: the runtime proves itself to the
application first, then the application installation earns a scoped grant.

## Still open

- Does `authorizationServer` work as a discovery root, or does the runtime card
  need a version 2 after all?
- What exactly does a `ClientIdentityClaim` carry, and how is it displayed when
  publisher verification is `none`?
- Where does the authorization-update (tool diff) flow live relative to the
  pairing endpoint, and does it need its own consent surface?
- The public-origin LNA experiment above, if only to document the failure mode
  for developers who try the bridge anyway.

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
