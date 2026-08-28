import {
  BackendEventQueue,
  type BackendEvent,
  type BackendRun,
  type BackendStartRequest,
  type ResponseBackend,
} from "../../src/responses/backend.js";

/**
 * A deterministic harness stand-in for protocol-fit tests. Each turn is the
 * event burst the harness produces before it either parks on an application
 * call or terminates; `submitOutput` releases the next turn.
 */
export type FakeTurn = readonly BackendEvent[];

export interface FakeBackendOptions {
  readonly turns: readonly FakeTurn[];
  readonly failStart?: Error;
  readonly failSubmit?: Error;
}

export class FakeBackend implements ResponseBackend {
  readonly kind = "fake";
  readonly runs: FakeBackendRun[] = [];
  private readonly options: FakeBackendOptions;

  constructor(options: FakeBackendOptions) {
    this.options = options;
  }

  async start(request: BackendStartRequest): Promise<BackendRun> {
    if (this.options.failStart) throw this.options.failStart;
    const run = new FakeBackendRun(request, this.options);
    this.runs.push(run);
    return run;
  }
}

export class FakeBackendRun implements BackendRun {
  readonly providerSessionId: string;
  readonly request: BackendStartRequest;
  readonly submitted: { token: string; output: string }[] = [];
  cancelled = false;
  closed = false;
  private readonly queue = new BackendEventQueue();
  private readonly options: FakeBackendOptions;
  private turn = 0;

  constructor(request: BackendStartRequest, options: FakeBackendOptions) {
    this.request = request;
    this.providerSessionId = request.providerSessionId;
    this.options = options;
    this.emitTurn();
  }

  isAlive(): boolean {
    return !this.closed && this.queue.open;
  }

  events(): AsyncIterator<BackendEvent> {
    return this.queue.iterator();
  }

  async submitOutput(providerToken: string, output: string): Promise<void> {
    if (this.options.failSubmit) throw this.options.failSubmit;
    this.submitted.push({ token: providerToken, output });
    this.emitTurn();
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.queue.push({ type: "cancelled" });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.end();
  }

  /** Simulates the harness transport dying under an otherwise healthy gateway. */
  killTransport(error: Error): void {
    this.queue.fail(error);
  }

  private emitTurn(): void {
    const events = this.options.turns[this.turn];
    this.turn += 1;
    if (!events) {
      this.queue.end();
      return;
    }
    for (const event of events) this.queue.push(event);
  }
}
