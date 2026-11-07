# Bind grants to the browser that paired

Status: needs-triage

Today the only thing tying a grant to its application is the `Origin` header,
which a non-browser client can set to anything. A copied refresh token therefore
works from anywhere until the grant expires or reuse detection revokes it. The
[credential model](credentials.md) documents this bearer-token risk.

The accepted direction is sender-constrained tokens: DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449))
with a non-extractable WebCrypto key created at pairing, so a copied token is
useless without the key that never leaves the browser.

The [research proposal](../research/2026-10-28-browser-grant-dpop.md) compares
three ways to carry the proof over the gateway's WebSocket. Still open before
implementation: which transport, how recovery works when the browser
loses the key, and how existing grants migrate.
