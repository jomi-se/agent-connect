# Surface model

Accepted 2026-11-22. What belongs to one address and what the whole gateway
shares; features that touch addresses start here.

## Context

A gateway can be reached at several addresses at once: `localhost` on the
same machine, a tailnet name, a public domain through a tunnel, a bare IP.
Browsers keep cookies and passkeys per hostname, and an application pairs with
the exact address it was given. ADR 0019 and the code settled, rule by rule,
what belongs to one address and what the whole gateway shares. This records
them as one model, so that each new feature has a place to start from.

## Model

1. **Two surfaces.** Applications use the gateway through one address. The
   owner runs it from a console that covers every address.
2. **To an application, each address is its own gateway.** Pairing, the
   approval (grant), the issuer, tokens and conversations belong to the
   address they were made at. A token from one address is refused at another,
   and `session/load` and `session/resume` admit only conversations started
   under the same grant, so a conversation cannot continue through another
   address, even from the same application.
3. **Approving a request is part of the application's surface.** The review
   page is the last step of the application's own sign-in: approving it sends
   that browser back to the application, with the address as issuer. It
   therefore happens at the address the request came through, with that
   address's factor.
4. **To the owner, it is one gateway.** Signed in at any address, the console
   shows and manages everything: requests waiting at every address (each
   linking to its own address for review), live sessions, application grants,
   and every address's factor. Seeing or revoking needs no second sign-in.
5. **Per address:** the sign-in factor (passkey or authenticator), the owner
   cookie, and the review of a request. **Shared by all addresses:** the agent,
   its workspace and files; the passphrase, which only opens setup at an address
   with no factor; and the console's view.
6. **A weaker factor never removes a stronger one.** A session signed in with
   an authenticator code cannot remove a passkey. Otherwise the passphrase and
   an authenticator at one address could remove the passkey at another and
   enroll their own there, since setup needs only the passphrase. Passkeys are
   removed from a passkey session, or on the host with `remove-factor`.
7. **One address is the usual case.** Where the applications run decides it:
   a public address for hosted applications, which reach the gateway from the
   internet; a tailnet name when every application runs on the owner's own
   devices; `localhost` for the same machine and first setup. With one
   address, the console never mentions addresses.

## Considered: owner sessions per address

Treating each address as a separate tenant on the owner's side too, so that a
console session sees and manages only its own address, would remove the
cross-address links of rule 4 and fold rule 6 into a general rule. It
was rejected: for one owner it adds sign-ins without adding security beyond
rule 6, and the console's purpose is to show what the gateway sees.
