import { existsSync } from "node:fs";

import { ConnectorAuth, type EnrollmentBundle } from "./connector-auth.js";

export interface GatewayInitializationOptions {
  readonly statePath: string;
  readonly publicEndpoint: string;
  readonly transportProfile?: string;
}

export function initializeGateway(
  options: GatewayInitializationOptions,
): EnrollmentBundle {
  if (existsSync(options.statePath)) {
    throw new Error(
      `Gateway state already exists at ${options.statePath}; the enrollment passphrase cannot be re-exported.`,
    );
  }

  let bundle: EnrollmentBundle | undefined;
  new ConnectorAuth({
    ...options,
    onEnrollmentBundle: (created) => {
      bundle = created;
    },
  });

  if (!bundle) {
    throw new Error(
      "Gateway initialization did not produce an enrollment bundle.",
    );
  }
  return bundle;
}
