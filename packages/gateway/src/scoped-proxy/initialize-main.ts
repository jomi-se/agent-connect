#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { initializeGateway } from "../initialize.js";

try {
  const statePath = required("AGENT_CONNECT_STATE_PATH");
  const publicEndpoint = required("AGENT_CONNECT_PUBLIC_ENDPOINT");
  if (!isAbsolute(statePath))
    throw new Error("AGENT_CONNECT_STATE_PATH must be absolute");
  const endpoint = new URL(publicEndpoint);
  if (endpoint.protocol !== "https:" || endpoint.origin !== publicEndpoint) {
    throw new Error(
      "AGENT_CONNECT_PUBLIC_ENDPOINT must be a canonical HTTPS origin",
    );
  }
  const bundle = initializeGateway({
    statePath,
    publicEndpoint,
    transportProfile: "explicit-owner-login",
  });
  process.stdout.write(
    `Agent Connect public runtime card:\n${JSON.stringify(bundle.runtimeCard, null, 2)}\n`,
  );
  process.stdout.write(
    `\nOwner enrollment secret (save now; it cannot be shown again):\n${bundle.enrollmentPassphrase}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Agent Connect scoped proxy initialization failed: ${
      error instanceof Error ? error.message : "invalid configuration"
    }\n`,
  );
  process.exitCode = 78;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
