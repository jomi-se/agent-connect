# VAL-RESP-001: The version 0 request profile is exact and schema-checked

Surface: api, protocol.
Needs: the pinned Open Responses OpenAPI document vendored at
`contract/open-responses/openapi.json` (commit
`92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c`, OpenAPI `3.1.0`, `info.version`
`2026-04-24`, `sha256:693f26090d206230ed22b336681f547a2882cf5b131e86743966cf71bbdeedab`).
Behavior: `POST /v1/responses` accepts exactly the version 0 profile and
rejects everything else with a stable code, distinguishing an unknown field
(`invalid_request`) from a known Open Responses field outside the profile
(`unsupported_feature`). Every returned response resource validates against the
pinned `ResponseResource` schema, including the six required non-nullable
sampling and service fields, which are rendered as the documented constant
profile because a harness-backed gateway does not decide them.
Evidence: `packages/gateway/test/open-responses-fixture.test.ts` asserts the
checksum and document version and that the six fields are still required and
still non-nullable; `packages/gateway/test/responses-profile.test.ts` runs the
accept/reject matrix; `packages/gateway/test/responses-engine.test.ts` and
`responses-route.test.ts` validate produced resources against the pinned schema
with a small evaluator in `test/support/openapi-schema.ts`.
Fail: an unsupported field is silently discarded; a rejection reports the wrong
code, status, or `param`; a produced resource omits a required property; or the
vendored document drifts from the recorded checksum.
Scope: the request and resource shapes only. Event ordering is `VAL-RESP-002`.

## Current status

Passed on 2026-08-28 for the version 0 profile.
