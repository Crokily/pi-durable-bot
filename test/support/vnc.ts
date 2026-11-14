import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Reader, vncAuthResponse } from "../../src/pages/rfb.ts";

// A VNC server for tests, on 127.0.0.1: the RFB handshake of a chosen version and sign-in, ServerInit, and the client
// messages a desktop page and Pots send. It records what each connection did, can change its desktop's size when a
// client asks (ExtendedDesktopSize), and tells its other clients when it does, as TigerVNC does.

export interface FakeVncOptions {
  /** The version it speaks, such as "003.008", "003.007", "003.003" or Apple's "003.889". */
  readonly version?: string;
  /** The sign-in types it offers. */
  readonly security?: readonly number[];
  /** The password for VncAuth. */
  readonly password?: string;
  /** Whether it tells its layout and takes SetDesktopSize. */
  readonly resizable?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly name?: string;
}

export interface FakeConnection {
  shared?: boolean;
  signedIn: boolean;
  encodings: number[];
  keys: { keysym: number; down: boolean }[];
  pointers: { x: number; y: number; mask: number }[];
  resizes: { width: number; height: number }[];
  closed: boolean;
}

export class FakeVnc {
  readonly connections: FakeConnection[] = [];
  width: number;
  height: number;
  readonly #server: Server;
  readonly #options: FakeVncOptions;
  readonly #live = new Set<{ socket: Socket; connection: FakeConnection; pending: Buffer[] }>();
  #screenId = 0x6b8b4567;

  private constructor(server: Server, options: FakeVncOptions) {
    this.#server = server;
    this.#options = options;
    this.width = options.width ?? 1280;
    this.height = options.height ?? 800;
  }

  static async start(options: FakeVncOptions = {}): Promise<FakeVnc> {
    let vnc: FakeVnc | undefined;
    const server = createServer((socket) => vnc!.#serve(socket));
    vnc = new FakeVnc(server, options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return vnc;
  }

  get port(): number {
    return (this.#server.address() as { port: number }).port;
  }

  /** Connections open now. */
  get open(): number {
    return [...this.#live].length;
  }

  async close(): Promise<void> {
    for (const client of this.#live) client.socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #layoutRect(reason: number, status: number): Buffer {
    const rect = Buffer.alloc(12 + 4 + 16);
    rect.writeUInt16BE(reason, 0);
    rect.writeUInt16BE(status, 2);
    rect.writeUInt16BE(this.width, 4);
    rect.writeUInt16BE(this.height, 6);
    rect.writeInt32BE(-308, 8);
    rect[12] = 1;
    rect.writeUInt32BE(this.#screenId, 16);
    rect.writeUInt16BE(this.width, 24);
    rect.writeUInt16BE(this.height, 26);
    return rect;
  }

  async #serve(socket: Socket): Promise<void> {
    const options = this.#options;
    const connection: FakeConnection = { signedIn: false, encodings: [], keys: [], pointers: [], resizes: [], closed: false };
    this.connections.push(connection);
    const client = { socket, connection, pending: [] as Buffer[] };
    const reader = new Reader();
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("close", () => {
      connection.closed = true;
      this.#live.delete(client);
      reader.fail(new Error("closed"));
    });
    socket.on("error", () => {});
    const read = (n: number) => reader.read(n);
    try {
      const version = options.version ?? "003.008";
      socket.write(`RFB ${version}\n`);
      const theirs = (await read(12)).toString("latin1");
      const minor = Number(theirs.slice(8, 11));
      const security = options.security ?? [2];
      let type: number;
      if (minor === 3) {
        type = security[0]!;
        const message = Buffer.alloc(4);
        message.writeUInt32BE(type);
        socket.write(message);
      } else {
        socket.write(Buffer.from([security.length, ...security]));
        if (security.length === 0) {
          const reason = Buffer.from("no way in");
          const length = Buffer.alloc(4);
          length.writeUInt32BE(reason.length);
          socket.write(Buffer.concat([length, reason]));
          socket.end();
          return;
        }
        type = (await read(1))[0]!;
      }
      let ok = true;
      if (type === 2) {
        const challenge = randomBytes(16);
        socket.write(challenge);
        const answer = await read(16);
        ok = answer.equals(vncAuthResponse(Buffer.from(options.password ?? "", "utf8"), challenge));
      }
      if (minor >= 8 || type === 2) {
        const result = Buffer.alloc(4);
        result.writeUInt32BE(ok ? 0 : 1);
        socket.write(result);
        if (!ok) {
          if (minor >= 8) {
            const reason = Buffer.from("Authentication failed");
            const length = Buffer.alloc(4);
            length.writeUInt32BE(reason.length);
            socket.write(Buffer.concat([length, reason]));
          }
          socket.end();
          return;
        }
      }
      connection.signedIn = true;
      connection.shared = (await read(1))[0] !== 0;
      const name = Buffer.from(options.name ?? "fake desktop", "utf8");
      const init = Buffer.alloc(24);
      init.writeUInt16BE(this.width, 0);
      init.writeUInt16BE(this.height, 2);
      init[4] = 32;
      init[5] = 24;
      init[7] = 1;
      init.writeUInt16BE(255, 8);
      init.writeUInt16BE(255, 10);
      init.writeUInt16BE(255, 12);
      init[14] = 16;
      init[15] = 8;
      init[16] = 0;
      init.writeUInt32BE(name.length, 20);
      socket.write(Buffer.concat([init, name]));
      this.#live.add(client);
      for (;;) {
        const message = (await read(1))[0]!;
        if (message === 0) await read(19);
        else if (message === 2) {
          const head = await read(3);
          const count = head.readUInt16BE(1);
          const list = await read(4 * count);
          connection.encodings = Array.from({ length: count }, (_, index) => list.readInt32BE(4 * index));
        } else if (message === 3) {
          const request = await read(9);
          const incremental = request[0] === 1;
          const rects: Buffer[] = [];
          if (!incremental) {
            const pixel = Buffer.alloc(12 + 4);
            pixel.writeUInt16BE(1, 4);
            pixel.writeUInt16BE(1, 6);
            rects.push(pixel);
            if (options.resizable && connection.encodings.includes(-308)) rects.push(this.#layoutRect(0, 0));
          }
          rects.push(...client.pending.splice(0));
          if (rects.length > 0) {
            const head = Buffer.alloc(4);
            head.writeUInt16BE(rects.length, 2);
            socket.write(Buffer.concat([head, ...rects]));
          }
        } else if (message === 4) {
          const key = await read(7);
          connection.keys.push({ down: key[0] === 1, keysym: key.readUInt32BE(3) });
        } else if (message === 5) {
          const pointer = await read(5);
          connection.pointers.push({ mask: pointer[0]!, x: pointer.readUInt16BE(1), y: pointer.readUInt16BE(3) });
        } else if (message === 6) {
          const head = await read(7);
          await read(head.readUInt32BE(3));
        } else if (message === 251) {
          const head = await read(7);
          const [width, height, count] = [head.readUInt16BE(1), head.readUInt16BE(3), head[5]!];
          const screens = await read(16 * count);
          connection.resizes.push({ width, height });
          if (!options.resizable) {
            client.pending.push(this.#layoutRect(1, 1));
            continue;
          }
          this.width = width;
          this.height = height;
          this.#screenId = screens.readUInt32BE(0);
          client.pending.push(this.#layoutRect(1, 0));
          for (const other of this.#live) if (other !== client && other.connection.encodings.includes(-308)) other.pending.push(this.#layoutRect(2, 0));
        } else throw new Error(`unknown client message ${message}`);
      }
    } catch {
      socket.destroy();
    }
  }
}
