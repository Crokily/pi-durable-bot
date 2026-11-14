import { createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { readSecrets } from "../core/env-file.ts";

// RFB, the VNC protocol (RFC 6143), as far as Pots speaks it: Pots signs in to a VNC server on this computer itself, so
// the browser of a desktop page gets a connection that needs no password, and Pots opens short connections of its own
// to read the desktop's size and screen layout and to set them back. The password stays in this process.

/** Where the VNC server listens: always this computer. */
export const VNC_HOST = "127.0.0.1";

/** A VNC server on this computer and how to sign in to it, from bot.json's vnc. */
export interface VncTarget {
  readonly port: number;
  /** The password's bytes, at most 8, or undefined when bot.json names no password file. */
  readonly password: Buffer | undefined;
  /** The file the password came from, for messages. */
  readonly passwordFile?: string;
}

/** The desktop as a VNC server describes it. */
export interface DesktopLayout {
  readonly width: number;
  readonly height: number;
  /** The screens of an ExtendedDesktopSize message, 16 bytes each, base64; absent when the server cannot change size. */
  readonly screens?: string;
}

/** What went wrong with a VNC server, in words for the bot. */
export class VncError extends Error {}
/** A VncError that already says which server. */
class VncProblem extends VncError {}

const SECURITY_NONE = 1;
const SECURITY_VNC = 2;
const SECURITY_NAMES: Record<number, string> = {
  1: "None",
  2: "VncAuth",
  5: "RA2",
  6: "RA2ne",
  13: "RA2_256",
  16: "Tight",
  18: "TLS",
  19: "VeNCrypt",
  22: "XVP",
  30: "Apple Remote Desktop",
  35: "Apple",
  113: "MSLogonII",
  129: "Unix login",
};
/** The pseudo-encoding with which a server tells its screen layout and takes SetDesktopSize. */
const EXTENDED_DESKTOP_SIZE = -308;
/** At most this much is read for one piece of a server message; a server that says more is not trusted. */
const MAX_READ = 64 * 1024 * 1024;

// ---- Passwords ----

/** Single DES in ECB: DES-EDE with both keys the same is DES, and OpenSSL 3 still has DES-EDE by default. */
function des(key8: Buffer, data: Buffer, decrypt: boolean): Buffer {
  const key = Buffer.concat([key8, key8]);
  const cipher = decrypt ? createDecipheriv("des-ede-ecb", key, null) : createCipheriv("des-ede-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

const reverseBits = (byte: number) => {
  let out = 0;
  for (let bit = 0; bit < 8; bit++) out |= ((byte >> bit) & 1) << (7 - bit);
  return out;
};

/** The answer to a VncAuth challenge: the challenge encrypted with the password, whose bytes VNC reverses bit by bit. */
export function vncAuthResponse(password: Buffer, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  password.copy(key, 0, 0, 8);
  return des(Buffer.from([...key].map(reverseBits)), challenge, false);
}

/** The fixed key that vncpasswd files are encrypted with, {23,82,107,6,35,78,88,7}, in DES's own bit order. */
const PASSWD_FILE_KEY = Buffer.from("e84ad660c4721ae0", "hex");

/**
 * The VNC password in a file: KEY=value lines with VNC_PASSWORD, as pots page secret writes them, or a password file
 * as vncpasswd, x11vnc -storepasswd and TightVNC write it (8 bytes, encrypted with VNC's fixed key). VNC uses the first
 * 8 bytes of a password.
 */
export function readVncPassword(file: string): Buffer {
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch (error) {
    throw new VncError(`cannot read the VNC password file ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  if (/(^|\n)\s*(export\s+)?VNC_PASSWORD\s*=/.test(data.toString("latin1"))) {
    const password = readSecrets(file, ["VNC_PASSWORD"]).VNC_PASSWORD!;
    return Buffer.from(password, "utf8").subarray(0, 8);
  }
  if (data.length === 8 || data.length === 16) {
    const plain = des(PASSWD_FILE_KEY, data.subarray(0, 8), true);
    const end = plain.indexOf(0);
    return end === -1 ? plain : plain.subarray(0, end);
  }
  throw new VncError(`${file} is neither KEY=value lines with VNC_PASSWORD nor a VNC password file as vncpasswd writes it (8 bytes)`);
}

// ---- Reading ----

/** Bytes as they come from a socket or a WebSocket, read in pieces of a given length. */
export class Reader {
  #chunks: Buffer[] = [];
  #length = 0;
  #want: { n: number; resolve: (data: Buffer) => void; reject: (error: Error) => void } | undefined;
  #error: Error | undefined;

  push(chunk: Buffer): void {
    if (this.#error) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    this.#serve();
  }

  /** Exactly n bytes, once they came. One read at a time. */
  read(n: number): Promise<Buffer> {
    if (this.#error) return Promise.reject(this.#error);
    if (n > MAX_READ) return Promise.reject(new VncError(`a message of ${n} bytes is too long`));
    if (this.#want) return Promise.reject(new Error("one read at a time"));
    return new Promise((resolve, reject) => {
      this.#want = { n, resolve, reject };
      this.#serve();
    });
  }

  /** Fail the read that waits, and every read after. */
  fail(error: Error): void {
    this.#error ??= error;
    const want = this.#want;
    this.#want = undefined;
    want?.reject(this.#error);
  }

  /** What came and was not read; the reader is empty after. */
  take(): Buffer {
    const all = Buffer.concat(this.#chunks);
    this.#chunks = [];
    this.#length = 0;
    return all;
  }

  #serve(): void {
    const want = this.#want;
    if (!want || this.#length < want.n) return;
    const all = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks);
    const rest = all.subarray(want.n);
    this.#chunks = rest.length > 0 ? [rest] : [];
    this.#length = rest.length;
    this.#want = undefined;
    want.resolve(all.subarray(0, want.n));
  }
}

/** Both directions of one RFB conversation. */
export interface Channel {
  read(n: number): Promise<Buffer>;
  write(data: Buffer): void;
}

// ---- Signing in ----

async function reasonText(channel: Channel): Promise<string> {
  const length = (await channel.read(4)).readUInt32BE(0);
  return (await channel.read(Math.min(length, 4096))).toString("utf8").trim();
}

function unsupported(types: readonly number[]): VncError {
  const names = types.map((type) => `${type}${SECURITY_NAMES[type] ? ` (${SECURITY_NAMES[type]})` : ""}`).join(", ");
  return new VncError(
    `it offers only these ways to sign in: ${names}. Pots signs in with None (1) or VncAuth (2), the VNC password; set the VNC server to offer VncAuth (on this computer only, TLS adds nothing)`,
  );
}

/**
 * Sign in to a VNC server as its client: the protocol version (3.3, 3.7 or 3.8; newer servers and Apple's speak 3.8),
 * then None when the server offers it, else VncAuth with the password.
 */
export async function signIn(channel: Channel, target: VncTarget): Promise<void> {
  const version = (await channel.read(12)).toString("latin1");
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
  if (!match) throw new VncError(`it does not speak VNC: it began with ${JSON.stringify(version)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 3) throw new VncError(`it speaks RFB ${major}.${minor}, older than 3.3`);
  const ours = major > 3 || minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
  channel.write(Buffer.from(`RFB 003.00${ours}\n`, "latin1"));
  let type: number;
  if (ours === 3) {
    type = (await channel.read(4)).readUInt32BE(0);
    if (type === 0) throw new VncError(`it refused the connection: ${await reasonText(channel)}`);
    if (type !== SECURITY_NONE && type !== SECURITY_VNC) throw unsupported([type]);
  } else {
    const count = (await channel.read(1))[0]!;
    if (count === 0) throw new VncError(`it refused the connection: ${await reasonText(channel)}`);
    const types = [...(await channel.read(count))];
    type = types.includes(SECURITY_NONE) ? SECURITY_NONE : types.includes(SECURITY_VNC) ? SECURITY_VNC : 0;
    if (type === 0) throw unsupported(types);
    channel.write(Buffer.from([type]));
  }
  if (type === SECURITY_VNC) {
    if (!target.password) throw new VncError('it asks for a password, and bot.json\'s "vnc" has no "passwordFile"');
    const challenge = await channel.read(16);
    channel.write(vncAuthResponse(target.password, challenge));
  }
  // 3.3 and 3.7 send no result for None.
  if (ours === 8 || type === SECURITY_VNC) {
    const result = (await channel.read(4)).readUInt32BE(0);
    if (result !== 0) {
      const why = ours === 8 ? await reasonText(channel).catch(() => "") : "";
      if (type === SECURITY_VNC) throw new VncError(`it refused the password in ${target.passwordFile ?? "the password file"}${why ? `: ${why}` : ""}`);
      throw new VncError(`it refused the connection${why ? `: ${why}` : ""}`);
    }
  }
}

/** The start of a ServerInit message: the desktop's size, its pixel format and its name, as the bytes came. */
export interface ServerInit {
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
  readonly name: string;
  /** The whole message, to pass on. */
  readonly bytes: Buffer;
}

export async function readServerInit(channel: Channel): Promise<ServerInit> {
  const head = await channel.read(24);
  const nameLength = head.readUInt32BE(20);
  const name = await channel.read(nameLength);
  return {
    width: head.readUInt16BE(0),
    height: head.readUInt16BE(2),
    bytesPerPixel: Math.max(1, Math.ceil(head[4]! / 8)),
    name: name.toString("utf8"),
    bytes: Buffer.concat([head, name]),
  };
}

// ---- Connections of Pots' own ----

/** A signed-in connection to the VNC server. */
export interface VncConnection extends Channel {
  readonly socket: Socket;
  readonly reader: Reader;
  /** Stop reading into the reader: what came and was not read, and every chunk after it, goes to sink. */
  handOver(sink: (chunk: Buffer) => void): void;
}

function connectionProblem(error: unknown, port: number): VncError {
  if (error instanceof VncProblem) return error;
  if (error instanceof VncError) return new VncProblem(`the VNC server at ${VNC_HOST}:${port}: ${error.message}`);
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return new VncProblem(`no VNC server listens at ${VNC_HOST}:${port} (the port of "vnc" in bot.json)`);
  return new VncProblem(`could not talk to the VNC server at ${VNC_HOST}:${port}: ${code ?? (error instanceof Error ? error.message : String(error))}`);
}

/** Connect to the VNC server on this computer and sign in, within timeoutMs. */
export async function connectVnc(target: VncTarget, timeoutMs: number): Promise<VncConnection> {
  const socket = connect({ host: VNC_HOST, port: target.port });
  socket.setNoDelay(true);
  const reader = new Reader();
  const toReader = (chunk: Buffer) => reader.push(chunk);
  socket.on("data", toReader);
  const failed = (error: Error) => reader.fail(error);
  socket.on("error", failed);
  socket.on("close", () => reader.fail(new VncError("it closed the connection")));
  const connection: VncConnection = {
    socket,
    reader,
    read: (n) => reader.read(n),
    write: (data) => {
      socket.write(data);
    },
    handOver: (sink) => {
      socket.off("data", toReader);
      const rest = reader.take();
      if (rest.length > 0) sink(rest);
      socket.on("data", sink);
    },
  };
  const timer = setTimeout(() => {
    reader.fail(new VncError(`it did not finish signing in within ${Math.round(timeoutMs / 1000)} seconds`));
    socket.destroy();
  }, timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await signIn(connection, target);
    return connection;
  } catch (error) {
    socket.destroy();
    throw connectionProblem(error, target.port);
  } finally {
    clearTimeout(timer);
  }
}

/** A connection of Pots' own that shares the desktop with the others: sign in, ClientInit (shared), ServerInit. */
async function withSession<T>(target: VncTarget, timeoutMs: number, work: (connection: VncConnection, init: ServerInit) => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const connection = await connectVnc(target, timeoutMs);
  const timer = setTimeout(
    () => {
      connection.reader.fail(new VncError(`it did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
      connection.socket.destroy();
    },
    Math.max(1, deadline - Date.now()),
  );
  try {
    connection.write(Buffer.from([1]));
    const init = await readServerInit(connection);
    return await work(connection, init);
  } catch (error) {
    throw connectionProblem(error, target.port);
  } finally {
    clearTimeout(timer);
    connection.socket.destroy();
  }
}

function setEncodings(encodings: readonly number[]): Buffer {
  const message = Buffer.alloc(4 + 4 * encodings.length);
  message[0] = 2;
  message.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + 4 * index));
  return message;
}

function updateRequest(incremental: boolean): Buffer {
  const message = Buffer.alloc(10);
  message[0] = 3;
  message[1] = incremental ? 1 : 0;
  message.writeUInt16BE(1, 6);
  message.writeUInt16BE(1, 8);
  return message;
}

/** An ExtendedDesktopSize rectangle: why it came (0 the server, 1 this client's request, 2 another client), its result, the size, the screens. */
interface LayoutRect {
  reason: number;
  status: number;
  width: number;
  height: number;
  screens: Buffer;
}

/**
 * The ExtendedDesktopSize rectangles of the next framebuffer update, skipping the server's other messages. Only raw
 * pixels and the two size pseudo-encodings can come, since these are all the connection asks for.
 */
async function nextUpdate(connection: VncConnection, bytesPerPixel: number): Promise<LayoutRect[]> {
  for (;;) {
    const type = (await connection.read(1))[0]!;
    if (type === 0) {
      const head = await connection.read(3);
      const count = head.readUInt16BE(1);
      const layouts: LayoutRect[] = [];
      for (let index = 0; index < count; index++) {
        const rect = await connection.read(12);
        const [x, y, width, height] = [rect.readUInt16BE(0), rect.readUInt16BE(2), rect.readUInt16BE(4), rect.readUInt16BE(6)];
        const encoding = rect.readInt32BE(8);
        if (encoding === 0) await connection.read(width * height * bytesPerPixel);
        else if (encoding === EXTENDED_DESKTOP_SIZE) {
          const screens = (await connection.read(4))[0]!;
          layouts.push({ reason: x, status: y, width, height, screens: await connection.read(16 * screens) });
        } else if (encoding !== -223) throw new VncError(`it sent encoding ${encoding}, which Pots did not ask for`);
      }
      return layouts;
    }
    if (type === 1) {
      const head = await connection.read(5);
      await connection.read(6 * head.readUInt16BE(3));
    } else if (type === 3) {
      const length = (await connection.read(7)).readInt32BE(3);
      await connection.read(Math.abs(length));
    } else if (type !== 2) throw new VncError(`it sent message type ${type}, which Pots did not ask for`);
  }
}

/** Read updates until one has an ExtendedDesktopSize rectangle that matches; give up after a few updates. */
async function layoutFrom(connection: VncConnection, init: ServerInit, wanted: (rect: LayoutRect) => boolean, updates: number): Promise<LayoutRect | undefined> {
  for (let index = 0; index < updates; index++) {
    const found = (await nextUpdate(connection, init.bytesPerPixel)).find(wanted);
    if (found) return found;
    connection.write(updateRequest(true));
  }
  return undefined;
}

/**
 * The desktop's size now, and its screen layout when the server can change the size (it sends ExtendedDesktopSize).
 * A server that cannot says nothing about it, so the answer waits for one framebuffer update at most.
 */
export function readDesktopLayout(target: VncTarget, timeoutMs = 10_000): Promise<DesktopLayout> {
  return withSession(target, timeoutMs, async (connection, init) => {
    connection.write(setEncodings([EXTENDED_DESKTOP_SIZE]));
    connection.write(updateRequest(false));
    const layout = await layoutFrom(connection, init, () => true, 1);
    return { width: init.width, height: init.height, ...(layout ? { screens: layout.screens.toString("base64") } : {}) };
  });
}

/**
 * Set the desktop back to a layout read before: "same" when it is that already, "set" when the server changed it,
 * "unsupported" when the server cannot change its size, or "refused <status>" with the server's reason code.
 */
export function restoreDesktopLayout(target: VncTarget, wanted: DesktopLayout, timeoutMs = 10_000): Promise<string> {
  return withSession(target, timeoutMs, async (connection, init) => {
    if (!wanted.screens) return init.width === wanted.width && init.height === wanted.height ? "same" : "unsupported";
    connection.write(setEncodings([EXTENDED_DESKTOP_SIZE]));
    connection.write(updateRequest(false));
    const now = await layoutFrom(connection, init, () => true, 1);
    if (!now) return "unsupported";
    if (now.width === wanted.width && now.height === wanted.height && now.screens.toString("base64") === wanted.screens) return "same";
    const screens = Buffer.from(wanted.screens, "base64");
    const message = Buffer.alloc(8);
    message[0] = 251;
    message.writeUInt16BE(wanted.width, 2);
    message.writeUInt16BE(wanted.height, 4);
    message[6] = screens.length / 16;
    connection.write(Buffer.concat([message, screens]));
    connection.write(updateRequest(true));
    const answer = await layoutFrom(connection, init, (rect) => rect.reason === 1, 8);
    if (!answer) throw new VncError("it did not answer the request to change the desktop's size");
    return answer.status === 0 ? "set" : `refused ${answer.status}`;
  });
}

/** The size of a layout, as people read it. */
export const sizeText = (layout: { width: number; height: number }) => `${layout.width}×${layout.height}`;
