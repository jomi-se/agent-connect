import type { GatewayToolDefinition } from "../tool-snapshot.js";

/**
 * The narrow translation contract between a harness and the response engine.
 * Only text, application calls, completion, failure, and cancellation cross it;
 * provider session IDs, `action_required`, and ACP events never do.
 */
export type BackendEvent =
  | { readonly type: "text.delta"; readonly delta: string }
  | {
      readonly type: "tool.call";
      /** Stays inside the gateway; the public `call_id` is allocated by the engine. */
      readonly providerToken: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly type: "completed" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "cancelled" };

/**
 * One long-lived harness run. It outlives any single client-facing response
 * segment: closing a segment at a function-call boundary must not end the run.
 */
export interface BackendRun {
  readonly providerSessionId: string;
  /**
   * The run's event stream. Called once per run. The implementation must read
   * its upstream transport continuously and buffer, so that events published
   * while no segment is open are not lost.
   */
  events(): AsyncIterator<BackendEvent>;
  submitOutput(providerToken: string, output: string): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface BackendStartRequest {
  readonly providerSessionId: string;
  readonly prompt: string;
  readonly tools: readonly GatewayToolDefinition[];
}

export interface ResponseBackend {
  /** Recorded on the durable chain record so recovery knows what it is holding. */
  readonly kind: string;
  start(request: BackendStartRequest): Promise<BackendRun>;
}

/**
 * An unbounded queue that lets a backend pump its transport independently of
 * whoever is consuming events. This is the mechanic that decouples run
 * ownership from one browser request.
 */
export class BackendEventQueue {
  private readonly buffered: BackendEvent[] = [];
  private readonly waiting: ((result: IteratorResult<BackendEvent>) => void)[] =
    [];
  private ended = false;
  private failure: Error | undefined;
  private readonly rejecting: ((reason: Error) => void)[] = [];

  push(event: BackendEvent): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    this.rejecting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.buffered.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) {
      this.rejecting.shift();
      waiter({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.waiting.splice(0);
    for (const reject of this.rejecting.splice(0)) reject(error);
  }

  iterator(): AsyncIterator<BackendEvent> {
    return {
      next: (): Promise<IteratorResult<BackendEvent>> => {
        const buffered = this.buffered.shift();
        if (buffered) return Promise.resolve({ value: buffered, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiting.push(resolve);
          this.rejecting.push(reject);
        });
      },
    };
  }
}
