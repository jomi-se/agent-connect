import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type {
  CallRecord,
  ChainRecord,
  ResponseRecord,
  ResponseStore,
} from "./store.js";

interface ChainFile {
  readonly version: 1;
  readonly chain: ChainRecord;
  readonly responses: Record<string, ResponseRecord>;
  readonly calls: Record<string, CallRecord>;
}

interface RetiredSessionsFile {
  readonly version: 1;
  readonly sessionIds: readonly string[];
}

export interface QuarantinedResponseState {
  readonly originalPath: string;
  readonly quarantinePath: string;
  readonly reason: string;
}

/**
 * Single-process, atomic, fsync-backed persistence for response chains.
 *
 * Persistence before publication is the whole point of this store, so a write
 * is not considered durable until the file contents and the directory entry
 * have both been flushed. Temporary-file-plus-rename alone leaves the rename
 * itself in the directory's page cache, where a machine loss can still drop it.
 *
 * One file per chain, and the index is rebuilt from those files at startup, so
 * a restarted gateway reconstructs chain authority from durable state alone
 * rather than from process memory.
 */
export class FileResponseStore implements ResponseStore {
  private readonly directory: string;
  private readonly retiredSessionsPath: string;
  private readonly retiredSessions = new Set<string>();
  private readonly files = new Map<string, ChainFile>();
  private readonly chainOfResponse = new Map<string, string>();
  private readonly chainOfCall = new Map<string, string>();
  private readonly durableWrite: typeof writeDurably;
  private readonly onCorruptFile: (event: QuarantinedResponseState) => void;
  private writes = Promise.resolve();

  constructor(
    directory: string,
    options: {
      readonly durableWrite?: typeof writeDurably;
      readonly onCorruptFile?: (event: QuarantinedResponseState) => void;
    } = {},
  ) {
    this.directory = directory;
    this.retiredSessionsPath = join(directory, "retired-sessions.state");
    this.durableWrite = options.durableWrite ?? writeDurably;
    this.onCorruptFile = options.onCorruptFile ?? reportCorruptFile;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(this.retiredSessionsPath)) {
      const state = loadRetiredSessions(this.retiredSessionsPath);
      for (const sessionId of state.sessionIds) {
        this.retiredSessions.add(sessionId);
      }
    }
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(directory, entry);
      try {
        this.index(this.load(path));
      } catch (cause) {
        this.quarantine(path, cause);
      }
    }
  }

  async retireSession(appSessionId: string): Promise<void> {
    await this.writeOperation(() => {
      const sessionIds = new Set(this.retiredSessions);
      sessionIds.add(appSessionId);
      const body = `${JSON.stringify(
        { version: 1, sessionIds: [...sessionIds].sort() },
        null,
        2,
      )}\n`;
      this.durableWrite(this.retiredSessionsPath, body, this.directory);
      this.retiredSessions.add(appSessionId);
    });
  }

  async isSessionRetired(appSessionId: string): Promise<boolean> {
    return this.retiredSessions.has(appSessionId);
  }

  async listChains(): Promise<readonly ChainRecord[]> {
    return [...this.files.values()].map((file) => file.chain);
  }

  async putChain(chain: ChainRecord): Promise<void> {
    await this.write(() => {
      const existing = this.files.get(chain.chainId);
      return {
        version: 1,
        chain,
        responses: existing?.responses ?? {},
        calls: existing?.calls ?? {},
      };
    });
  }

  async getChain(chainId: string): Promise<ChainRecord | undefined> {
    return this.files.get(chainId)?.chain;
  }

  async putResponse(response: ResponseRecord): Promise<void> {
    await this.write(() => {
      const file = this.require(response.chainId);
      return {
        ...file,
        responses: { ...file.responses, [response.responseId]: response },
      };
    });
  }

  async getResponse(responseId: string): Promise<ResponseRecord | undefined> {
    const chainId = this.chainOfResponse.get(responseId);
    return chainId ? this.files.get(chainId)?.responses[responseId] : undefined;
  }

  async putCall(call: CallRecord): Promise<void> {
    await this.write(() => {
      const file = this.require(call.chainId);
      return {
        ...file,
        calls: { ...file.calls, [call.callId]: call },
      };
    });
  }

  async getCall(callId: string): Promise<CallRecord | undefined> {
    const chainId = this.chainOfCall.get(callId);
    return chainId ? this.files.get(chainId)?.calls[callId] : undefined;
  }

  async unresolvedCalls(chainId: string): Promise<readonly CallRecord[]> {
    return Object.values(this.files.get(chainId)?.calls ?? {}).filter(
      (call) => call.result !== "provider_observed",
    );
  }

  private require(chainId: string): ChainFile {
    const file = this.files.get(chainId);
    if (!file) throw new Error(`unknown response chain: ${chainId}`);
    return file;
  }

  private index(file: ChainFile): void {
    this.files.set(file.chain.chainId, file);
    for (const responseId of Object.keys(file.responses)) {
      this.chainOfResponse.set(responseId, file.chain.chainId);
    }
    for (const callId of Object.keys(file.calls)) {
      this.chainOfCall.set(callId, file.chain.chainId);
    }
  }

  private write(createFile: () => ChainFile): Promise<void> {
    // Serialized so two concurrent updates to one chain cannot interleave a
    // rename between another writer's write and its own. A failed operation is
    // not retained as the queue tail: later writes must still be attempted.
    return this.writeOperation(() => {
      const file = createFile();
      const path = join(this.directory, `${file.chain.chainId}.json`);
      const body = `${JSON.stringify(file, null, 2)}\n`;
      this.durableWrite(path, body, this.directory);
      // Reads never observe state that was not durably committed.
      this.index(file);
    });
  }

  private writeOperation(operationBody: () => void): Promise<void> {
    const operation = this.writes.then(operationBody);
    this.writes = operation.catch(() => {});
    return operation;
  }

  private load(path: string): ChainFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      throw new Error(`Cannot load response state ${path}`, { cause });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as ChainFile).version !== 1 ||
      typeof (parsed as ChainFile).chain?.chainId !== "string"
    ) {
      throw new Error(`Invalid response state ${path}`);
    }
    const file = parsed as ChainFile;
    return {
      version: 1,
      chain: {
        ...file.chain,
        sessionTurn:
          Number.isSafeInteger(file.chain.sessionTurn) &&
          file.chain.sessionTurn >= 0
            ? file.chain.sessionTurn
            : 0,
        continuedFromResponseId:
          typeof file.chain.continuedFromResponseId === "string"
            ? file.chain.continuedFromResponseId
            : null,
      },
      responses: file.responses ?? {},
      calls: file.calls ?? {},
    };
  }

  private quarantine(path: string, cause: unknown): void {
    const quarantinePath = `${path}.corrupt-${randomBytes(6).toString("hex")}`;
    renameSync(path, quarantinePath);
    fsyncPath(this.directory);
    this.onCorruptFile({
      originalPath: path,
      quarantinePath,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function loadRetiredSessions(path: string): RetiredSessionsFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RetiredSessionsFile;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.sessionIds) ||
    parsed.sessionIds.some((sessionId) => typeof sessionId !== "string")
  ) {
    throw new Error(`Invalid retired response-session state ${path}`);
  }
  return parsed;
}

function reportCorruptFile(event: QuarantinedResponseState): void {
  process.stderr.write(
    `Quarantined corrupt response state ${event.originalPath} as ${event.quarantinePath}: ${event.reason}\n`,
  );
}

function writeDurably(path: string, body: string, directory: string): void {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
    fsyncPath(temporary);
    renameSync(temporary, path);
    // The rename itself is only durable once the directory entry is flushed.
    fsyncPath(directory);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
