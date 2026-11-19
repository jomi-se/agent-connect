# Owner passkeys

Status: ready-for-human

Each entry-point address gets one second factor, a passkey or TOTP, never
both. A passkey signs in and approves on its own; TOTP needs the passphrase
too; an address with neither can only enroll one. Passkey is the default, and
TOTP covers addresses that cannot have one (IP literals). Recovery is one
host-side reset per address. No migration: the gateway-wide TOTP enrollment is
dropped on upgrade.

[ADR 0019](../decisions/0019-owner-passkeys.md) holds the table and the
decisions, and was accepted on 2026-11-19. Next: a step plan that names what
is still unknown, starting with which WebAuthn library ships on every release
target.
