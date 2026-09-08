import { describe, expect, it } from "vitest";

import {
  getOpenClawConnectionProviderUrl,
  normalizeOpenClawProviderUrl,
  parseOpenClawConnection,
  serializeOpenClawConnection,
  type OpenClawApplicationTool,
  type OpenClawConnection,
} from "../src/openclaw-connection.js";

const ORIGIN = "https://claw.example";
const APP_ORIGIN = "https://books.example";
const NOW = Date.parse("2026-09-08T12:00:00.000Z");

describe("saved OpenClaw connections", () => {
  it.each([
    {
      endpoint: `${ORIGIN}/v1/responses`,
      providerUrl: ORIGIN,
    },
    {
      endpoint: `${ORIGIN}/agent-connect/v1/responses`,
      providerUrl: `${ORIGIN}/agent-connect`,
    },
  ])(
    "round trips the $providerUrl layout",
    async ({ endpoint, providerUrl }) => {
      const original = await connection({ endpoint });
      const parsed = await parseOpenClawConnection(JSON.stringify(original), {
        clientId: APP_ORIGIN,
        now: NOW,
      });

      expect(parsed).toEqual(original);
      expect(parsed).not.toBe(original);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.applicationTools[0]?.inputSchema)).toBe(
        true,
      );
      expect(getOpenClawConnectionProviderUrl(parsed)).toBe(providerUrl);
      expect(
        await parseOpenClawConnection(serializeOpenClawConnection(parsed), {
          clientId: APP_ORIGIN,
          now: NOW,
        }),
      ).toEqual(parsed);
    },
  );

  it("normalizes only the two supported provider address layouts", () => {
    expect(normalizeOpenClawProviderUrl(`${ORIGIN}/`)).toBe(ORIGIN);
    expect(normalizeOpenClawProviderUrl(`${ORIGIN}/agent-connect`)).toBe(
      `${ORIGIN}/agent-connect`,
    );
    expect(() => normalizeOpenClawProviderUrl(`${ORIGIN}/other`)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() =>
      normalizeOpenClawProviderUrl("https://user:secret@claw.example"),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("accepts expired access with live refresh and rejects expired refresh", async () => {
    const refreshable = await connection({
      expiresAt: "2026-09-08T11:59:00.000Z",
      refreshTokenExpiresAt: "2026-09-08T12:01:00.000Z",
    });
    await expect(
      parseOpenClawConnection(JSON.stringify(refreshable), {
        clientId: APP_ORIGIN,
        now: NOW,
      }),
    ).resolves.toMatchObject({ accessToken: "access-one" });

    await expect(
      parseOpenClawConnection(
        JSON.stringify({
          ...refreshable,
          refreshTokenExpiresAt: "2026-09-08T12:00:00.000Z",
        }),
        { clientId: APP_ORIGIN, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "connection_expired" });
  });

  it("rejects altered ownership, layout, fields, tool hash and schemas", async () => {
    const value = await connection();
    const cases: unknown[] = [
      { ...value, endpoint: "https://attacker.example/v1/responses" },
      { ...value, unexpected: true },
      { ...value, applicationToolsHash: "a".repeat(43) },
      {
        ...value,
        applicationTools: [
          {
            ...value.applicationTools[0],
            inputSchema: { type: "object", multipleOf: 2 },
          },
        ],
      },
    ];
    for (const candidate of cases) {
      await expect(
        parseOpenClawConnection(JSON.stringify(candidate), {
          clientId: APP_ORIGIN,
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      parseOpenClawConnection(JSON.stringify(value), {
        clientId: "https://other.example",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not serialize records beyond the restore bound", async () => {
    const value = await connection();
    expect(() =>
      serializeOpenClawConnection({
        ...value,
        applicationTools: [
          {
            ...value.applicationTools[0]!,
            inputSchema: {
              type: "object",
              title: "x".repeat(256 * 1024),
            },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });
});

async function connection(
  overrides: Partial<OpenClawConnection> = {},
): Promise<OpenClawConnection> {
  const applicationTools: readonly OpenClawApplicationTool[] = [
    {
      name: "lookup",
      description: "Look up a passage",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ];
  return {
    version: 1,
    providerOrigin: ORIGIN,
    endpoint: `${ORIGIN}/v1/responses`,
    clientId: APP_ORIGIN,
    accessToken: "access-one",
    refreshToken: "refresh-one",
    expiresAt: "2026-09-08T13:00:00.000Z",
    refreshTokenExpiresAt: "2026-09-09T12:00:00.000Z",
    model: "openclaw/default",
    applicationTools,
    applicationToolsHash: await hash(applicationTools),
    ...overrides,
  };
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
