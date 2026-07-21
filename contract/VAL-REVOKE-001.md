# VAL-REVOKE-001: Durable grant revocation blocks active application access

Surface: API and persistence.
Needs: an application grant issued by VAL-AUTHZ-001.
Behavior: the gateway stores only the grant-token hash and exact bindings.
Grant state and revocation survive gateway state reload. Revocation prevents
new session capability issuance and rejects an already-issued capability before
any provider request.
Evidence: integration test creates a grant and session, revokes through the
gateway page, observes 401 and zero upstream calls on the existing session,
then reloads state and observes the persisted revocation timestamp.
Fail: plaintext grant is stored, restart restores access, or an already-issued
capability reaches Omnigent after revocation.
Scope: provider-session mappings remain memory-only. Device management and
distributed revocation are deferred.

## Current status

Passed automated gateway integration coverage on 2026-07-14.
