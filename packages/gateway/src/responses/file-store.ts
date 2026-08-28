import {
  closeSync,
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
  private readonly files = new Map<string, ChainFile>();
  private readonly chainOfResponse = new Map<string, string>();
  private readonly chainOfCall = new Map<string, string>();
  private writes = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      const loaded = this.load(join(directory, entry));
      if (loaded) this.index(loaded);
    }
  }

  async listChains(): Promise<readonly ChainRecord[]> {
    return [...this.files.values()].map((file) => file.chain);
  }

  async putChain(chain: ChainRecord): Promise<void> {
    const existing = this.files.get(chain.chainId);
    await this.write({
      version: 1,
      chain,
      responses: existing?.responses ?? {},
      calls: existing?.calls ?? {},
    });
  }

  async getChain(chainId: string): Promise<ChainRecord | undefined> {
    return this.files.get(chainId)?.chain;
  }

  async putResponse(response: ResponseRecord): Promise<void> {
    const file = this.require(response.chainId);
    await this.write({
      ...file,
      responses: { ...file.responses, [response.responseId]: response },
    });
  }

  async getResponse(responseId: string): Promise<ResponseRecord | undefined> {
    const chainId = this.chainOfResponse.get(responseId);
    return chainId ? this.files.get(chainId)?.responses[responseId] : undefined;
  }

  async putCall(call: CallRecord): Promise<void> {
    const file = this.require(call.chainId);
    await this.write({
      ...file,
      calls: { ...file.calls, [call.callId]: call },
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

  private write(file: ChainFile): Promise<void> {
    this.index(file);
    const path = join(this.directory, `${file.chain.chainId}.json`);
    const body = `${JSON.stringify(file, null, 2)}\n`;
    // Serialized so two concurrent updates to one chain cannot interleave a
    // rename between another writer's write and its own.
    this.writes = this.writes.then(() => {
      writeDurably(path, body, this.directory);
    });
    return this.writes;
  }

  private load(path: string): ChainFile | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as ChainFile).version !== 1 ||
      typeof (parsed as ChainFile).chain?.chainId !== "string"
    ) {
      return undefined;
    }
    const file = parsed as ChainFile;
    return {
      version: 1,
      chain: file.chain,
      responses: file.responses ?? {},
      calls: file.calls ?? {},
    };
  }
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
