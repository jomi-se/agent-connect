#!/usr/bin/env node
import { configFromEnv } from "./config.js";
import { initializeGateway } from "./initialize.js";

try {
  const config = configFromEnv();
  const bundle = initializeGateway({
    statePath: config.authStatePath,
    publicEndpoint: config.publicEndpoint,
    ...(config.transportProfile
      ? { transportProfile: config.transportProfile }
      : {}),
  });
  process.stdout.write(
    `Agent Connect public runtime card (safe to paste into an app):\n${JSON.stringify(bundle.runtimeCard, null, 2)}\n`,
  );
  process.stdout.write(
    `\nAgent Connect enrollment secret (save now in your password manager; it cannot be shown again):\n${bundle.enrollmentPassphrase}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Agent Connect initialization failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 78;
}
