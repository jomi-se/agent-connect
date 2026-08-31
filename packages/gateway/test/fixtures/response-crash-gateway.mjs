import { appendFileSync, writeFileSync } from "node:fs";

import { createGateway } from "../../dist/gateway.js";
import { BackendEventQueue } from "../../dist/responses/backend.js";
import { FileResponseStore } from "../../dist/responses/file-store.js";

const root = required("CRASH_FIXTURE_ROOT");
const crashPoint = process.env.CRASH_FIXTURE_POINT ?? "none";
const markerPath = `${root}/checkpoint.json`;
const providerLedgerPath = `${root}/provider-ledger.jsonl`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function appendProvider(event) {
  appendFileSync(providerLedgerPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function checkpoint(point, details = {}) {
  if (crashPoint !== point) return;
  writeFileSync(
    markerPath,
    `${JSON.stringify({ point, ...details })}\n`,
    "utf8",
  );
  // The parent sends SIGKILL after observing the marker. Keeping the operation
  // suspended makes the tested boundary deterministic instead of depending on
  // a filesystem polling race.
  await new Promise(() => {});
}

class CheckpointStore {
  constructor(directory) {
    this.inner = new FileResponseStore(directory);
  }

  listChains() {
    return this.inner.listChains();
  }

  retireSession(appSessionId) {
    return this.inner.retireSession(appSessionId);
  }

  isSessionRetired(appSessionId) {
    return this.inner.isSessionRetired(appSessionId);
  }

  putChain(chain) {
    return this.inner.putChain(chain);
  }

  getChain(chainId) {
    return this.inner.getChain(chainId);
  }

  putResponse(response) {
    return this.inner.putResponse(response);
  }

  getResponse(responseId) {
    return this.inner.getResponse(responseId);
  }

  async putCall(call) {
    if (
      crashPoint === "after_output_persistence_before_post" &&
      call.result === "output_recorded"
    ) {
      await this.inner.putCall(call);
      await checkpoint(crashPoint, { callId: call.callId });
      return;
    }
    if (
      crashPoint === "after_ack_before_local_transition" &&
      call.result === "delivery_attempted"
    ) {
      await checkpoint(crashPoint, { callId: call.callId });
      return;
    }
    if (
      crashPoint === "after_provider_next_item" &&
      call.name === "confirm_test_nonce" &&
      call.publication === "recorded"
    ) {
      await checkpoint(crashPoint, { callId: call.callId });
      return;
    }
    await this.inner.putCall(call);
  }

  getCall(callId) {
    return this.inner.getCall(callId);
  }

  unresolvedCalls(chainId) {
    return this.inner.unresolvedCalls(chainId);
  }
}

class CrashBackend {
  kind = "crash-fixture";

  async start(request) {
    return new CrashRun(request.providerSessionId);
  }
}

class CrashRun {
  constructor(providerSessionId) {
    this.providerSessionId = providerSessionId;
    this.queue = new BackendEventQueue();
    this.closed = false;
    this.queue.push({
      type: "tool.call",
      providerToken: "provider_call_1",
      name: "get_test_nonce",
      arguments: "{}",
    });
  }

  isAlive() {
    return !this.closed && this.queue.open;
  }

  events() {
    return this.queue.iterator();
  }

  async submitOutput(providerToken, output) {
    appendProvider({ phase: "received", providerToken, output });
    if (crashPoint === "after_post_before_acknowledgement") {
      await checkpoint(crashPoint, { providerToken });
      return;
    }
    this.queue.push({
      type: "tool.call",
      providerToken: "provider_call_2",
      name: "confirm_test_nonce",
      arguments: "{}",
    });
    appendProvider({ phase: "acknowledged", providerToken });
  }

  async cancel() {
    this.queue.push({ type: "cancelled" });
  }

  async close() {
    this.closed = true;
    this.queue.end();
  }
}

const gateway = createGateway({
  allowedOrigins: new Set(["https://integration.example"]),
  allowedTailscaleUsers: new Set(["owner@example.com"]),
  omnigentBaseUrl: "http://127.0.0.1:1",
  runtime: {
    createSession: async () => "provider_1",
    isHealthy: async () => true,
  },
  responseBackend: new CrashBackend(),
  responseStore: new CheckpointStore(`${root}/responses`),
  authStatePath: `${root}/gateway-auth.json`,
  publicEndpoint: "https://integration-runtime.example",
  enrollmentPassphrase: "integration enrollment phrase",
});

const port = Number(required("CRASH_FIXTURE_PORT"));
gateway.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
});

const close = () => gateway.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
