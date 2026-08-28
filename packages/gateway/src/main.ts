#!/usr/bin/env node
import { existsSync } from "node:fs";

import { configFromEnv } from "./config.js";
import { createGateway } from "./gateway.js";

const config = configFromEnv();
if (!existsSync(config.authStatePath)) {
  process.stderr.write(
    `Agent Connect gateway is not initialized at ${config.authStatePath}. Run the one-shot initializer first.\n`,
  );
  process.exit(78);
}

const server = createGateway(config);
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Agent Connect gateway listening on http://${config.host}:${config.port}\n`,
  );
});
