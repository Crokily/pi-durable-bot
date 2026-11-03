import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Context, Effect, Fiber, FiberSet, Layer } from "effect";
import type { ChannelAdapter, FileInfo } from "../core/channel.ts";
import type { WakeFile } from "../core/wake.ts";
import { Channels } from "./channels.ts";
import { GatewayConfig } from "./config.ts";
import { message } from "./errors.ts";
import type { UndecidedEvent } from "./log.ts";

/** A download that takes longer fails, so a wake never waits longer for its files. */
export const DOWNLOAD_MS = 60_000;

/** Events whose files the wake gives: the ones that bring or change a message. */
const KINDS = new Set(["message", "edit", "update"]);

/**
 * Saves the files of messages people send, as soon as the event comes, so the wake can give each file's local path.
 * One folder per message in the bot's files folder, and in it one numbered folder per file, so two files never share a
 * path; a file already there is not downloaded again. A download that fails or takes too long gives the file's URL and
 * why instead. Nothing here holds up the adapter's acknowledgement: the event is in the inbox before the download
 * starts. Before the event's channel runs, nothing starts: the wake saves the files when it asks for them.
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /** Start saving the files of the event's message, in the background. */
    start(event: UndecidedEvent): Effect.Effect<void>;
    /** The files of the event's message, once saving them ended; each download ends within DOWNLOAD_MS. */
    files(event: UndecidedEvent): Effect.Effect<readonly WakeFile[]>;
    /** Stop the downloads in progress. A wake that waits for one stops waiting too, and its events stay undecided. */
    readonly stop: Effect.Effect<void>;
  }
>()("pots/gateway/Attachments") {
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const channels = yield* Channels;
      const config = yield* GatewayConfig;
      const running = yield* FiberSet.make<readonly WakeFile[]>();
      const saving = new Map<number, Fiber.Fiber<readonly WakeFile[]>>();

      const save = (event: UndecidedEvent, list: readonly FileInfo[], adapter: ChannelAdapter | undefined) =>
        Effect.gen(function* () {
          const folder = join(config.filesDir, folderName(event.message!));
          const files = yield* Effect.forEach(list, (file, index) => saveOne(adapter, file, join(folder, String(index + 1), fileName(file, index))), {
            concurrency: "unbounded",
          });
          const failed = files.filter((file) => file.error).length;
          yield* Effect.annotateCurrentSpan({ saved: files.length - failed, failed });
          if (failed) config.print("file not saved", { channel: event.channel, event: event.id, failed, error: files.find((file) => file.error)!.error });
          return files;
        }).pipe(Effect.withSpan("files.save", { attributes: { channel: event.channel, event: event.id, files: list.length } }));

      const start = (event: UndecidedEvent) =>
        Effect.gen(function* () {
          const known = saving.get(event.id);
          if (known) return known;
          const list = filesOf(event);
          const adapter = channels.running(event.channel);
          const fiber = yield* FiberSet.run(running, list.length ? save(event, list, adapter) : Effect.succeed([]));
          // Without its channel, the result is not kept: the next ask tries again.
          if (adapter) saving.set(event.id, fiber);
          return fiber;
        });

      return Attachments.of({
        start: (event) => (filesOf(event).length && channels.running(event.channel) ? Effect.asVoid(start(event)) : Effect.void),
        files: (event) =>
          filesOf(event).length
            ? Effect.flatMap(start(event), Fiber.join).pipe(Effect.ensuring(Effect.sync(() => saving.delete(event.id))))
            : Effect.succeed([]),
        stop: Effect.gen(function* () {
          saving.clear();
          yield* FiberSet.clear(running);
        }),
      });
    }),
  );
}

/** The files of the event's message that the wake gives, as the adapter described them. */
function filesOf(event: UndecidedEvent): readonly FileInfo[] {
  if (!event.files || !event.message || !KINDS.has(event.kind)) return [];
  try {
    const files = JSON.parse(event.files) as unknown;
    return Array.isArray(files) ? (files as FileInfo[]) : [];
  } catch {
    return [];
  }
}

/** Save one file at path, or say why not. */
function saveOne(adapter: ChannelAdapter | undefined, file: FileInfo, path: string): Effect.Effect<WakeFile> {
  const about = { ...(file.name ? { name: file.name } : {}), ...(file.type ? { type: file.type } : {}) };
  const failed = (error: string): WakeFile => ({ ...about, ...(file.url ? { url: file.url } : {}), error });
  if (existsSync(path)) return Effect.succeed({ ...about, path });
  if (!file.url) return Effect.succeed(failed("the channel gave no URL"));
  if (!adapter) return Effect.succeed(failed("the channel is not running"));
  if (!adapter.fetchFile) return Effect.succeed(failed(`the ${adapter.id} channel does not download files`));
  const fetchFile = adapter.fetchFile.bind(adapter);
  return Effect.tryPromise({ try: (signal) => download(() => fetchFile(file, signal), path, signal), catch: message }).pipe(
    Effect.timeoutOrElse({ duration: DOWNLOAD_MS, orElse: () => Effect.fail(`it took longer than ${DOWNLOAD_MS / 1000} s`) }),
    Effect.match({ onSuccess: (): WakeFile => ({ ...about, path }), onFailure: (error) => failed(`download failed: ${error}`) }),
  );
}

/** Write to a part file first, so a file at the path is always whole. */
async function download(fetch: () => Promise<Uint8Array | AsyncIterable<Uint8Array>>, path: string, signal: AbortSignal): Promise<void> {
  const part = `${path}.${randomUUID().slice(0, 8)}.part`;
  try {
    const content = await fetch();
    await mkdir(dirname(path), { recursive: true });
    await pipeline(Readable.from(content instanceof Uint8Array ? [content] : content), createWriteStream(part), { signal });
    await rename(part, path);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/** One folder per message: its address with only letters, digits, ".", "_" and "-". */
function folderName(address: string): string {
  return address.replace(/[^\w.-]+/g, "_");
}

/** A file name that is safe on every system. */
function fileName(file: FileInfo, index: number): string {
  let name = basename((file.name ?? "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"|?*]+/g, "_")
    .trim();
  if (!name || /^\.+$/.test(name)) name = `file-${index + 1}`;
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = name.slice(0, 120 - extension.length) + extension;
  }
  return name;
}
