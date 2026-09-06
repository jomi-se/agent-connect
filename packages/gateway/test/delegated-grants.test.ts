import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DelegatedGrantError,
  DelegatedGrantPersistenceUncertainError,
  DelegatedGrantService,
  type DelegatedGrantStore,
  type DelegatedTokenResult,
} from "../src/delegated-grants.js";

const CLIENT_ID = "https://bookhand.example";
const REDIRECT_URI = "https://bookhand.example/connect/callback";
const RESOURCE = "https://openclaw.example/v1/responses";
const VERIFIER = "correct-horse-battery-staple-correct-horse-battery";
const POLICY = {
  ref: "bookhand-standard",
  label: "Bookhand standard",
  agentId: "bookhand-agent",
  fingerprint: "sha256:policy-v1",
  nativeCapabilities: ["public_web_search"] as const,
};

class MemoryStore implements DelegatedGrantStore {
  value: unknown;
  failNextSave = false;
  uncertainNextSave = false;

  load(): unknown | undefined {
    return clone(this.value);
  }

  save(value: unknown): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected persistence failure");
    }
    this.value = clone(value);
    if (this.uncertainNextSave) {
      this.uncertainNextSave = false;
      throw new DelegatedGrantPersistenceUncertainError(
        new Error("injected uncertain commit"),
      );
    }
  }
}

function createService(
  store: MemoryStore,
  options: {
    now?: () => number;
    fingerprint?: string;
    accessTokenTtlSeconds?: number;
    grantTtlSeconds?: number;
  } = {},
) {
  return new DelegatedGrantService({
    resource: RESOURCE,
    offeredPolicies: [
      {
        ...POLICY,
        fingerprint: options.fingerprint ?? POLICY.fingerprint,
      },
    ],
    store,
    ...(options.now ? { now: options.now } : {}),
    ...(options.accessTokenTtlSeconds
      ? { accessTokenTtlSeconds: options.accessTokenTtlSeconds }
      : {}),
    ...(options.grantTtlSeconds
      ? { grantTtlSeconds: options.grantTtlSeconds }
      : {}),
  });
}

function createRequest(service: DelegatedGrantService, tools: unknown = []) {
  return service.createRequest({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
    state: "opaque-client-state",
    codeChallenge: pkceChallenge(VERIFIER),
    codeChallengeMethod: "S256",
    applicationTools: tools,
  });
}

function approveAndExchange(
  service: DelegatedGrantService,
  tools: unknown = [],
): DelegatedTokenResult {
  const request = createRequest(service, tools);
  const approval = service.approve(request.requestUri, {
    ownerSubject: "tailscale:user@example.com",
    policyRef: POLICY.ref,
  });
  return service.exchange({
    code: approval.code,
    codeVerifier: VERIFIER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
  });
}

describe("delegated grant requests", () => {
  it("binds a canonical HTTPS origin, same-origin redirect and fixed resource", () => {
    const service = createService(new MemoryStore());
    const request = createRequest(service);

    expect(request).toMatchObject({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      codeChallengeMethod: "S256",
      applicationTools: [],
    });
    expect(request.requestUri).toMatch(
      /^urn:ietf:params:oauth:request_uri:ac_request_/,
    );
    expect(request.toolHash).toBe(
      createHash("sha256").update("[]").digest("base64url"),
    );
    expect(service.listOfferedPolicies()).toEqual([
      {
        ref: POLICY.ref,
        label: POLICY.label,
        agentId: POLICY.agentId,
        nativeCapabilities: ["public_web_search"],
      },
    ]);

    expect(() =>
      service.createRequest({
        ...requestInput(),
        clientId: "https://bookhand.example/",
      }),
    ).toThrowError(errorCode("invalid_client"));
    expect(() =>
      service.createRequest({
        ...requestInput(),
        redirectUri: "https://attacker.example/callback",
      }),
    ).toThrowError(errorCode("invalid_redirect_uri"));
    expect(() =>
      service.createRequest({
        ...requestInput(),
        resource: "https://openclaw.example/admin",
      }),
    ).toThrowError(errorCode("invalid_resource"));
  });

  it("normalizes the exact approved application tool snapshot", () => {
    const service = createService(new MemoryStore());
    const tool = {
      name: "add_note",
      description: "Add one note to the open book",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    };
    const request = createRequest(service, [tool]);
    expect(request.applicationTools).toEqual([tool]);
    expect(() => createRequest(service, [{ ...tool, strict: true }])).toThrow(
      errorCode("invalid_application_tools"),
    );
  });

  it("accepts only a host-selected offered policy", () => {
    const service = createService(new MemoryStore());
    const request = createRequest(service);
    expect(() =>
      service.approve(request.requestUri, {
        ownerSubject: "tailscale:user@example.com",
        policyRef: "client-invented-host-filesystem",
      }),
    ).toThrow(errorCode("invalid_policy"));
    expect(service.getRequest(request.requestUri)).toBeDefined();
  });

  it("consumes a denied PAR request", () => {
    const service = createService(new MemoryStore());
    const request = createRequest(service);
    expect(service.deny(request.requestUri)).toEqual(request);
    expect(service.getRequest(request.requestUri)).toBeUndefined();
    expect(() => service.deny(request.requestUri)).toThrow(
      errorCode("authorization_request_expired"),
    );
  });
});

describe("delegated token lifecycle", () => {
  it("stores only token hashes and keeps one grant subject across refresh", () => {
    const store = new MemoryStore();
    const service = createService(store);
    const first = approveAndExchange(service);

    expect(first.accessToken).toMatch(/^ac_access_/);
    expect(first.refreshToken).toMatch(/^ac_refresh_/);
    expect(JSON.stringify(store.value)).not.toContain(first.accessToken);
    expect(JSON.stringify(store.value)).not.toContain(first.refreshToken);

    const verified = service.verify(first.accessToken, { resource: RESOURCE });
    expect(verified).toMatchObject({
      grantId: first.grant.grantId,
      subject: `agent-connect:grant:${first.grant.grantId}`,
      clientId: CLIENT_ID,
      agentId: POLICY.agentId,
      policyRef: POLICY.ref,
      policyFingerprint: POLICY.fingerprint,
      nativeCapabilities: ["public_web_search"],
    });
    expect(
      service.verify(first.accessToken, {
        resource: RESOURCE,
        origin: CLIENT_ID,
      }),
    ).toBeDefined();
    expect(
      service.verify(first.accessToken, {
        resource: RESOURCE,
        origin: "https://other.example",
      }),
    ).toBeUndefined();

    const second = service.refresh({
      refreshToken: first.refreshToken,
      clientId: CLIENT_ID,
      resource: RESOURCE,
    });
    expect(second.grant.grantId).toBe(first.grant.grantId);
    expect(second.grant.subject).toBe(first.grant.subject);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(
      service.verify(first.accessToken, { resource: RESOURCE }),
    ).toBeUndefined();
    expect(service.recheck(verified!)).toBe(false);
    expect(() =>
      service.refresh({
        refreshToken: first.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }),
    ).toThrow(errorCode("refresh_token_reuse"));
  });

  it("revokes a refresh family when an old token is replayed after reload", () => {
    const store = new MemoryStore();
    const original = createService(store);
    const first = approveAndExchange(original);
    const second = original.refresh({
      refreshToken: first.refreshToken,
      clientId: CLIENT_ID,
      resource: RESOURCE,
    });

    const reloaded = createService(store);
    expect(() =>
      reloaded.refresh({
        refreshToken: first.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }),
    ).toThrow(errorCode("refresh_token_reuse"));
    expect(
      reloaded.verify(second.accessToken, { resource: RESOURCE }),
    ).toBeUndefined();
    expect(() =>
      reloaded.refresh({
        refreshToken: second.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }),
    ).toThrow(errorCode("invalid_refresh_token"));

    const afterReplay = createService(store);
    expect(
      afterReplay.verify(second.accessToken, { resource: RESOURCE }),
    ).toBeUndefined();
  });

  it("caps refreshed tokens at the original finite grant lifetime", () => {
    const store = new MemoryStore();
    let now = 1_000_000;
    const service = createService(store, {
      now: () => now,
      accessTokenTtlSeconds: 60,
      grantTtlSeconds: 100,
    });
    const first = approveAndExchange(service);
    expect(first.expiresIn).toBe(60);
    expect(first.refreshTokenExpiresIn).toBe(100);

    now += 50_000;
    const second = service.refresh({
      refreshToken: first.refreshToken,
      clientId: CLIENT_ID,
      resource: RESOURCE,
    });
    expect(second.expiresIn).toBe(50);
    expect(second.refreshTokenExpiresIn).toBe(50);

    now += 50_000;
    expect(() =>
      service.refresh({
        refreshToken: second.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }),
    ).toThrow(errorCode("invalid_refresh_token"));
  });

  it("uses an authorization code once and consumes it on a binding failure", () => {
    const service = createService(new MemoryStore());
    const approval = service.approve(createRequest(service).requestUri, {
      ownerSubject: "tailscale:user@example.com",
      policyRef: POLICY.ref,
    });
    const exchange = {
      code: approval.code,
      codeVerifier: VERIFIER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
    };

    expect(() =>
      service.exchange({ ...exchange, codeVerifier: `${VERIFIER}x` }),
    ).toThrow(errorCode("invalid_authorization_code"));
    expect(() => service.exchange(exchange)).toThrow(
      errorCode("invalid_authorization_code"),
    );
  });

  it("rechecks revocation and the exact tool snapshot before effects", () => {
    const service = createService(new MemoryStore());
    const tool = {
      name: "add_note",
      description: "Add one note",
      inputSchema: { type: "object", properties: {} },
    };
    const tokens = approveAndExchange(service, [tool]);
    const verified = service.verify(tokens.accessToken, { resource: RESOURCE });
    expect(verified).toBeDefined();
    expect(service.recheck(verified!, { applicationTools: [tool] })).toBe(true);
    expect(
      service.recheck(verified!, {
        applicationTools: [{ ...tool, description: "Changed authority" }],
      }),
    ).toBe(false);

    expect(service.revokeByToken(tokens.refreshToken, CLIENT_ID)).toBe(true);
    expect(service.recheck(verified!)).toBe(false);
    expect(
      service.verify(tokens.accessToken, { resource: RESOURCE }),
    ).toBeUndefined();
    expect(() =>
      service.refresh({
        refreshToken: tokens.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }),
    ).toThrow(errorCode("invalid_refresh_token"));
  });

  it("fails closed when the configured policy fingerprint changes", () => {
    const store = new MemoryStore();
    const original = createService(store);
    const tokens = approveAndExchange(original);
    const changed = createService(store, { fingerprint: "sha256:policy-v2" });

    expect(
      changed.verify(tokens.accessToken, { resource: RESOURCE }),
    ).toBeUndefined();
    expect(() =>
      changed.refresh({
        refreshToken: tokens.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }),
    ).toThrow(errorCode("policy_changed"));
  });

  it("does not issue credentials or poison retries after persistence failure", () => {
    const store = new MemoryStore();
    const service = createService(store);
    const request = createRequest(service);
    store.failNextSave = true;
    expect(() =>
      service.approve(request.requestUri, {
        ownerSubject: "tailscale:user@example.com",
        policyRef: POLICY.ref,
      }),
    ).toThrow("injected persistence failure");
    expect(service.getRequest(request.requestUri)).toBeDefined();

    const approval = service.approve(request.requestUri, {
      ownerSubject: "tailscale:user@example.com",
      policyRef: POLICY.ref,
    });
    const exchange = {
      code: approval.code,
      codeVerifier: VERIFIER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
    };
    store.failNextSave = true;
    expect(() => service.exchange(exchange)).toThrow(
      "injected persistence failure",
    );
    const first = service.exchange(exchange);

    store.failNextSave = true;
    expect(() =>
      service.refresh({
        refreshToken: first.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }),
    ).toThrow("injected persistence failure");
    expect(
      service.verify(first.accessToken, { resource: RESOURCE }),
    ).toBeDefined();
    expect(
      service.refresh({
        refreshToken: first.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      }).grant.grantId,
    ).toBe(first.grant.grantId);
  });

  it("fails closed until reload after an uncertain persistence commit", () => {
    const store = new MemoryStore();
    const service = createService(store);
    const tokens = approveAndExchange(service);
    store.uncertainNextSave = true;

    expect(() => service.revoke(tokens.grant.grantId)).toThrow(
      DelegatedGrantPersistenceUncertainError,
    );
    expect(
      service.verify(tokens.accessToken, { resource: RESOURCE }),
    ).toBeUndefined();
    expect(() => createRequest(service)).toThrow(
      errorCode("persistence_reload_required"),
    );

    const reloaded = createService(store);
    expect(
      reloaded.verify(tokens.accessToken, { resource: RESOURCE }),
    ).toBeUndefined();
  });

  it("persists a complete hashed-token lifecycle with private file mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "ac-delegated-grants-"));
    const statePath = join(directory, "grants.json");
    const options = {
      resource: RESOURCE,
      offeredPolicies: [POLICY],
      statePath,
    } as const;
    try {
      const initial = new DelegatedGrantService(options);
      const first = approveAndExchange(initial);
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
      let persisted = readFileSync(statePath, "utf8");
      expect(persisted).not.toContain(first.accessToken);
      expect(persisted).not.toContain(first.refreshToken);

      const afterExchange = new DelegatedGrantService(options);
      expect(
        afterExchange.verify(first.accessToken, { resource: RESOURCE }),
      ).toBeDefined();
      const second = afterExchange.refresh({
        refreshToken: first.refreshToken,
        clientId: CLIENT_ID,
        resource: RESOURCE,
      });

      const afterRefresh = new DelegatedGrantService(options);
      expect(
        afterRefresh.verify(second.accessToken, { resource: RESOURCE }),
      ).toBeDefined();
      expect(afterRefresh.revokeByToken(second.accessToken, CLIENT_ID)).toBe(
        true,
      );

      const afterRevoke = new DelegatedGrantService(options);
      expect(
        afterRevoke.verify(second.accessToken, { resource: RESOURCE }),
      ).toBeUndefined();
      persisted = readFileSync(statePath, "utf8");
      for (const token of [
        first.accessToken,
        first.refreshToken,
        second.accessToken,
        second.refreshToken,
      ]) {
        expect(persisted).not.toContain(token);
      }
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function requestInput() {
  return {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
    state: "opaque-client-state",
    codeChallenge: pkceChallenge(VERIFIER),
    codeChallengeMethod: "S256" as const,
    applicationTools: [],
  };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function errorCode(code: string): DelegatedGrantError {
  return new DelegatedGrantError(code);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
