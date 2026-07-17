# VAL-JUDGE-006: Global limits bound public resource consumption

Surface: API and operator.
Needs: `public-demo` configuration and an instrumented fake or deterministic
runtime that can prove whether downstream launch occurred.
Behavior: the public profile enforces a 4096-byte UTF-8 prompt ceiling, at most
two active task streams, a 45-second task/stream timeout, and rolling global
limits of 30 accepted message events, 10 session creations, and 60 authorization
requests per hour. It permits at most two concurrent enrollment-verification
operations and invalidates only the pending authorization that accumulates five
failed passphrases. It caps live pending authorization requests at 64,
authorization codes at 64, and managed sessions at 16, pruning requests at the
existing 10-minute TTL and codes at the existing 2-minute TTL. Excess requests
receive stable `413`, `429` with `Retry-After`, or the documented timeout error
before avoidable downstream work. These are immutable `public-demo` profile
constants for the judge deployment; the private profile retains its established
defaults.
Timeout or disconnect aborts the provider stream, sends downstream interrupt/
cancel when possible, and releases capacity.
Evidence: real HTTP boundary tests for each limit and reset window, zero
downstream calls on pre-launch rejection, downstream cancellation and capacity
release after timeout/disconnect, bounded pending request/code/session state,
and a post-rejection successful request. Exercise authorization-request,
session-create, accepted-message, and enrollment-failure budgets separately.

Fail: an allowed-Origin caller can grow memory or active work without bound,
limits are enforced only after runner launch, or one rejected request leaves
capacity permanently consumed.
Scope: hackathon counters may be process-local and reset on restart. Per-grant
quota persistence and billing are explicitly deferred.
