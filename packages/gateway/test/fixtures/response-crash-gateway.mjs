// Actual gateway process; only the AC-owned persistence boundary is faulted.
import { createGateway } from "../../dist/gateway.js";
import { FileResponseStore } from "../../dist/responses/file-store.js";
import { join } from "node:path";

process.once("message", (config) => {
  const store = new FileResponseStore(join(config.directory, "responses"));
  const putCall = store.putCall.bind(store);
  store.putCall = async (call) => {
    await putCall(call);
    if (
      (config.crashAt === "recorded" && call.result === "none") ||
      (config.crashAt === "delivery_attempted" &&
        call.result === "delivery_attempted")
    ) {
      process.exit(86);
    }
  };
  const server = createGateway({
    allowedOrigins: new Set(["https://preview.example"]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    openclawBaseUrl: config.baseUrl,
    openclawToken: config.token,
    openclawAgentId: config.agentId,
    authStatePath: join(config.directory, "gateway.json"),
    publicEndpoint: "https://runtime.example",
    enrollmentPassphrase: "test enrollment phrase",
    responseStore: store,
  });
  server.listen(0, "127.0.0.1", () =>
    process.send({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
  );
});
