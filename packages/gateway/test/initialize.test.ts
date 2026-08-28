import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { initializeGateway } from "../src/initialize.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("gateway initialization", () => {
  it("emits a generated passphrase once and persists only its verifier", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-init-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "gateway.json");
    const bundle = initializeGateway({
      statePath,
      publicEndpoint: "https://gateway.example",
      transportProfile: "tailscale-serve",
    });
    const persisted = readFileSync(statePath, "utf8");

    expect(bundle.enrollmentPassphrase).toMatch(/^AC-ENROLL-/);
    expect(persisted).not.toContain(bundle.enrollmentPassphrase);
    expect(JSON.parse(persisted)).toMatchObject({
      enrollmentSalt: expect.any(String),
      enrollmentVerifier: expect.any(String),
    });
    expect(() =>
      initializeGateway({
        statePath,
        publicEndpoint: "https://gateway.example",
        transportProfile: "tailscale-serve",
      }),
    ).toThrow("the enrollment passphrase cannot be re-exported");
  });
});
