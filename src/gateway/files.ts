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

/** A file larger than this, in bytes, is not downloaded: the wake gives its URL. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A wake waits at most this long for the downloads of its files, from when it would go out without them. */
export const FILE_WAIT_MS = 10_000;

/** Events whose files the wake gives: the ones that bring or change a message. */
const KINDS = new Set(["message", "edit", "update"]);

/**
 * Saves the files of messages people send, as soon as the event comes, so the wake can give each file's local path.
 * One folder per message in the bot's files folder, and in it one numbered folder per file, so two files never share a
 * path; a file already there is not downloaded again. A file larger than MAX_FILE_BYTES is not downloaded. The wake
 * waits for the others at most FILE_WAIT_MS, then stops the downloads that have not ended. A file not saved gives its
 * URL and why instead. Nothing here holds up the adapter's acknowledgement: the event is in the inbox before the
 * download starts. Before the event's channel runs, nothing starts: the wake saves the files when it asks for them.
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /** Start saving the files of the event's message, in the background. */
    start(event: UndecidedEvent): Effect.Effect<void>;
    /**
     * The files of the event's message, once saving them ended, or after FILE_WAIT_MS: a download that has not ended by
     * then is stopped, and the file is not saved.
     */
    files(event: UndecidedEvent): Effect.Effect<readonly WakeFile[]>;
    /** Stop the downloads of an event that no wake gives. */
    drop(event: UndecidedEvent): Effect.Effect<void>;
    /** Stop the downloads in progress. A wake that waits for one stops waiting too, and its events stay undecided. */
    readonly stop: Effect.Effect<void>;
  }
>()("pots/gateway/Attachments") {
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const channels = yield* Channels;
      const config = yield* GatewayConfig;
      const running = yield* FiberSet.make<WakeFile>();
      /** Per event, one download per file. */
      const saving = new Map<number, readonly Fiber.Fiber<WakeFile>[]>();

      const start = (event: UndecidedEvent) =>
        Effect.gen(function* () {
          const known = saving.get(event.id);
          if (known) return known;
          const adapter = channels.running(event.channel);
          const folder = join(config.filesDir, folderName(event.message!));
          const fibers = yield* Effect.forEach(filesOf(event), (file, index) =>
            FiberSet.run(
              running,
              saveOne(adapter, file, join(folder, String(index + 1), fileName(file, index))).pipe(
                Effect.tap((saved) => Effect.annotateCurrentSpan(saved.error ? { error: saved.error } : { saved: true })),
                Effect.withSpan("files.save", { attributes: { channel: event.channel, event: event.id, file: index + 1 } }),
              ),
            ),
          );
          // Without its channel, the result is not kept: the next ask tries again.
          if (adapter) saving.set(event.id, fibers);
          return fibers;
        });

      /** A file whose download had not ended in time: the download stops. */
      const late = (fiber: Fiber.Fiber<WakeFile>, file: FileInfo) => Effect.as(Fiber.interrupt(fiber), notSaved(file, "it was not downloaded in time"));

      const files = (event: UndecidedEvent) =>
        Effect.gen(function* () {
          const list = filesOf(event);
          const fibers = yield* start(event);
          // All at once, so no file waits longer than FILE_WAIT_MS from here.
          const files = yield* Effect.forEach(
            fibers,
            (fiber, index) => Fiber.join(fiber).pipe(Effect.timeoutOrElse({ duration: FILE_WAIT_MS, orElse: () => late(fiber, list[index]!) })),
            { concurrency: "unbounded" },
          );
          const failed = files.filter((file) => file.error);
          if (failed.length) config.print("file not saved", { channel: event.channel, event: event.id, failed: failed.length, error: failed[0]!.error });
          return files;
        }).pipe(Effect.ensuring(Effect.sync(() => saving.delete(event.id))));

      return Attachments.of({
        start: (event) => (filesOf(event).length && channels.running(event.channel) ? Effect.asVoid(start(event)) : Effect.void),
        files: (event) => (filesOf(event).length ? files(event) : Effect.succeed([])),
        drop: (event) =>
          Effect.suspend(() => {
            const fibers = saving.get(event.id);
            saving.delete(event.id);
            return fibers ? Fiber.interruptAll(fibers) : Effect.void;
          }),
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

/** A file that is not saved, with its URL and why. */
function notSaved(file: FileInfo, error: string): WakeFile {
  return { ...about(file), ...(file.url ? { url: file.url } : {}), error };
}

function about(file: FileInfo): WakeFile {
  return { ...(file.name ? { name: file.name } : {}), ...(file.type ? { type: file.type } : {}), ...(file.size === undefined ? {} : { size: file.size }) };
}

/** Save one file at path, or say why not. */
function saveOne(adapter: ChannelAdapter | undefined, file: FileInfo, path: string): Effect.Effect<WakeFile> {
  if (existsSync(path)) return Effect.succeed({ ...about(file), path });
  if (!file.url) return Effect.succeed(notSaved(file, "the channel gave no URL"));
  if (file.size !== undefined && file.size > MAX_FILE_BYTES) return Effect.succeed(notSaved(file, `it is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`));
  if (!adapter) return Effect.succeed(notSaved(file, "the channel is not running"));
  if (!adapter.fetchFile) return Effect.succeed(notSaved(file, `the ${adapter.id} channel does not download files`));
  const fetchFile = adapter.fetchFile.bind(adapter);
  return Effect.tryPromise({ try: (signal) => download(() => fetchFile(file, signal), path, signal), catch: message }).pipe(
    Effect.match({ onSuccess: (): WakeFile => ({ ...about(file), path }), onFailure: (error) => notSaved(file, `download failed: ${error}`) }),
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
