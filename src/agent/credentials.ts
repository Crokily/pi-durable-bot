import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialStore, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/**
 * pi's `~/.pi/agent/auth.json`, shared with the pi CLI. Writes (OAuth refresh) take the same
 * `proper-lockfile` lock as pi, so the two never refresh a rotating token at the same time.
 */
export class PiAuthFile implements CredentialStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  #readAll(): Record<string, Credential> {
    return existsSync(this.#path) ? JSON.parse(readFileSync(this.#path, "utf8").replace(/^﻿/, "")) : {};
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.#readAll()[providerId];
  }

  async list(): Promise<{ providerId: string; type: Credential["type"] }[]> {
    return Object.entries(this.#readAll()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.#locked(async () => {
      const all = this.#readAll();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      writeFileSync(this.#path, JSON.stringify({ ...all, [providerId]: next }, null, 2), { encoding: "utf8", mode: 0o600 });
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.#locked(async () => {
      const all = this.#readAll();
      delete all[providerId];
      writeFileSync(this.#path, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
    });
  }

  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = await lockfile.lock(this.#path, { realpath: false, stale: 30_000, retries: { retries: 20, minTimeout: 50, maxTimeout: 2_000 } });
    try {
      return await fn();
    } finally {
      await release().catch(() => {});
    }
  }
}

/** Dynamic model catalogs (the OpenAI catalog lists gpt-6.1-sol), kept in the bot's data directory. */
export class FileModelsStore implements ModelsStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async #readAll(): Promise<Record<string, ModelsStoreEntry>> {
    try {
      return JSON.parse(await readFile(this.#path, "utf8"));
    } catch {
      return {};
    }
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return (await this.#readAll())[providerId];
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    const all = await this.#readAll();
    all[providerId] = entry;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(all), { mode: 0o600 });
  }

  async delete(providerId: string): Promise<void> {
    const all = await this.#readAll();
    delete all[providerId];
    await writeFile(this.#path, JSON.stringify(all), { mode: 0o600 });
  }
}
