import { randomBytes } from "node:crypto";

import type { VerifiedDelegatedGrant } from "../../../gateway/src/delegated-grants.js";

export interface ContinuationRecord {
  readonly responseId: string;
  readonly grantId: string;
  readonly authorizationVersion: string;
  readonly policyRef: string;
  readonly policyFingerprint: string;
  readonly agentId: string;
  readonly toolHash: string;
  readonly conversationId: string;
  readonly sessionKey: string;
  readonly pendingCallIds: readonly string[];
  readonly expiresAt: number;
}

export interface ConversationReservation {
  readonly id: string;
  readonly grant: VerifiedDelegatedGrant;
  readonly conversationId: string;
  readonly sessionKey: string;
  readonly predecessorId?: string;
  readonly expiresAt: number;
  active: boolean;
  pendingResponseId?: string;
}

export class ContinuationRegistryError extends Error {
  constructor(readonly code: "conversation_capacity" | "response_busy") {
    super(code);
  }
}

export class ContinuationRegistry {
  private readonly records = new Map<string, ContinuationRecord>();
  private readonly pendingResponseIds = new Set<string>();
  private readonly reservations = new Map<string, ConversationReservation>();

  constructor(
    private readonly options: {
      readonly ttlMs?: number;
      readonly maxConversations?: number;
      readonly maxConversationsPerGrant?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  peek(
    responseId: string,
    grant: VerifiedDelegatedGrant,
  ): ContinuationRecord | undefined {
    this.prune();
    const record = this.records.get(responseId);
    return record && matchesGrant(record, grant) ? record : undefined;
  }

  list(grant: VerifiedDelegatedGrant): readonly ContinuationRecord[] {
    this.prune();
    return [...this.records.values()]
      .filter((record) => matchesGrant(record, grant))
      .sort((a, b) => b.expiresAt - a.expiresAt);
  }

  reserveNew(grant: VerifiedDelegatedGrant): ConversationReservation {
    this.prune();
    const total = this.records.size + this.reservations.size;
    const perGrant =
      [...this.records.values()].filter(
        (value) => value.grantId === grant.grantId,
      ).length +
      [...this.reservations.values()].filter(
        (value) => value.grant.grantId === grant.grantId,
      ).length;
    if (
      total >= (this.options.maxConversations ?? 1024) ||
      perGrant >= (this.options.maxConversationsPerGrant ?? 8)
    ) {
      throw new ContinuationRegistryError("conversation_capacity");
    }
    const id = randomBytes(18).toString("base64url");
    // OpenClaw canonicalizes session keys to lowercase. Generate the exact
    // canonical form so work-start fencing cannot observe a key change.
    const conversationId = randomBytes(18).toString("hex");
    const reservation: ConversationReservation = {
      id,
      grant,
      conversationId,
      sessionKey: `agent:${grant.agentId}:openresponses:agent-connect-${conversationId}`,
      expiresAt: this.now() + this.ttlMs(),
      active: true,
    };
    this.reservations.set(id, reservation);
    return reservation;
  }

  consume(
    responseId: string,
    grant: VerifiedDelegatedGrant,
  ): ConversationReservation | undefined {
    this.prune();
    const record = this.records.get(responseId);
    if (!record || !matchesGrant(record, grant)) return undefined;
    this.records.delete(responseId);
    const id = randomBytes(18).toString("base64url");
    const reservation: ConversationReservation = {
      id,
      grant,
      conversationId: record.conversationId,
      sessionKey: record.sessionKey,
      predecessorId: responseId,
      expiresAt: this.now() + this.ttlMs(),
      active: true,
    };
    this.reservations.set(id, reservation);
    return reservation;
  }

  reserveResponseId(
    reservation: ConversationReservation,
    responseId: string,
  ): boolean {
    if (
      !this.isActive(reservation) ||
      reservation.predecessorId === responseId ||
      this.records.has(responseId) ||
      this.pendingResponseIds.has(responseId)
    ) {
      return false;
    }
    this.pendingResponseIds.add(responseId);
    reservation.pendingResponseId = responseId;
    return true;
  }

  complete(
    reservation: ConversationReservation,
    responseId: string,
    pendingCallIds: readonly string[],
  ): void {
    if (
      !this.isActive(reservation) ||
      reservation.pendingResponseId !== responseId ||
      !this.pendingResponseIds.has(responseId)
    ) {
      throw new ContinuationRegistryError("response_busy");
    }
    this.pendingResponseIds.delete(responseId);
    delete reservation.pendingResponseId;
    this.reservations.delete(reservation.id);
    reservation.active = false;
    this.records.set(responseId, {
      responseId,
      grantId: reservation.grant.grantId,
      authorizationVersion: reservation.grant.authorizationVersion,
      policyRef: reservation.grant.policyRef,
      policyFingerprint: reservation.grant.policyFingerprint,
      agentId: reservation.grant.agentId,
      toolHash: reservation.grant.toolHash,
      conversationId: reservation.conversationId,
      sessionKey: reservation.sessionKey,
      pendingCallIds: [...pendingCallIds],
      expiresAt: this.now() + this.ttlMs(),
    });
  }

  fail(reservation: ConversationReservation): void {
    if (!reservation.active) return;
    const pending = reservation.pendingResponseId;
    if (pending) this.pendingResponseIds.delete(pending);
    delete reservation.pendingResponseId;
    this.reservations.delete(reservation.id);
    reservation.active = false;
  }

  get size(): number {
    this.prune();
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
    this.pendingResponseIds.clear();
    for (const reservation of this.reservations.values()) {
      reservation.active = false;
      delete reservation.pendingResponseId;
    }
    this.reservations.clear();
  }

  private isActive(reservation: ConversationReservation): boolean {
    return (
      reservation.active &&
      this.reservations.get(reservation.id) === reservation
    );
  }

  private prune(): void {
    const now = this.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(id);
    }
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) {
        if (reservation.pendingResponseId) {
          this.pendingResponseIds.delete(reservation.pendingResponseId);
        }
        this.reservations.delete(id);
        reservation.active = false;
      }
    }
  }

  private ttlMs(): number {
    return this.options.ttlMs ?? 30 * 60 * 1000;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function matchesGrant(
  record: ContinuationRecord,
  grant: VerifiedDelegatedGrant,
): boolean {
  return (
    record.grantId === grant.grantId &&
    record.authorizationVersion === grant.authorizationVersion &&
    record.policyRef === grant.policyRef &&
    record.policyFingerprint === grant.policyFingerprint &&
    record.agentId === grant.agentId &&
    record.toolHash === grant.toolHash
  );
}
