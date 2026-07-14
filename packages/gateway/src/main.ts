#!/usr/bin/env node
import { configFromEnv } from "./config.js";
import { createGateway } from "./gateway.js";

const config = configFromEnv();
const server = createGateway({
  ...config,
  onEnrollmentBundle: (bundle) => {
    process.stdout.write(
      `Agent Connect public runtime card (safe to paste into an app):\n${JSON.stringify(bundle.runtimeCard, null, 2)}\n\nAgent Connect enrollment secret (save in your password manager; never paste into an app):\n${bundle.enrollmentPassphrase}\n`,
    );
  },
  onPairingCodeGenerated: (code, expiresAt) => {
    process.stdout.write(
      `Agent Connect pairing code: ${code} (expires ${expiresAt})\n`,
    );
  },
});
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Agent Connect gateway listening on http://${config.host}:${config.port}\n`,
  );
});
