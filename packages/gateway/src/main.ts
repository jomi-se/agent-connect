#!/usr/bin/env node
import { configFromEnv } from "./config.js";
import { createGateway } from "./gateway.js";

const config = configFromEnv();
const server = createGateway(config);
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Agent Connect gateway listening on http://${config.host}:${config.port}\n`,
  );
});
