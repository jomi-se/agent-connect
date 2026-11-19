# Owner passkeys

Status: ready-for-human

Each entry-point address gets one second factor, a passkey or TOTP, never
both. A passkey signs in and approves on its own; TOTP needs the passphrase
too; an address with neither can only enroll one. Passkey is the default, and
TOTP covers addresses that cannot have one (IP literals). Recovery is one
host-side reset per address. No migration: the gateway-wide TOTP enrollment is
dropped on upgrade.

[ADR 0019](../decisions/0019-owner-passkeys.md) holds the table and the
decisions, and waits for the owner to accept it. First step after that:
check that `webauthn-rs` and its OpenSSL 3 dependency build and link on every
release target.
