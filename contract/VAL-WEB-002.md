# VAL-WEB-002: Request-scoped application tool round trip

Surface: library.
Needs: VAL-WEB-001 and a fixed non-empty application tool snapshot.
Behavior: The task snapshots the application's tool definitions and sends those schemas on its first message. An application tool request is validated against its declared JSON schema before invocation. Within one live task, repeated delivery of the same stable action ID executes the handler at most once; one successful call posts one result correlated through the provider's opaque request token and the task reaches completion.
Evidence: Integration-style provider test asserting immutable request schema snapshot, valid handler inputs, missing/wrong/extra argument rejection, public action ID, result post body, event order, duplicate suppression, one successful call, and terminal completion.
Fail: Unknown tools execute, invalid arguments reach a handler, handler errors leak stacks, a repeated action ID executes twice in one task, or result correlation is lost.
Scope: Mutating-tool approval and durable deduplication are deferred.
