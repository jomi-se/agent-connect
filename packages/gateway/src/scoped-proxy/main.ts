#!/usr/bin/env node
import { scopedProxyConfigFromEnv } from "./config.js";
import { createScopedResponsesProxy } from "./server.js";

try {
  const config = await scopedProxyConfigFromEnv();
  const server = createScopedResponsesProxy(config);
  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `Agent Connect scoped proxy listening on http://${config.host}:${config.port}\n`,
    );
  });
} catch (error) {
  process.stderr.write(
    `Agent Connect scoped proxy failed to start: ${
      error instanceof Error ? error.message : "invalid configuration"
    }\n`,
  );
  process.exitCode = 78;
}
