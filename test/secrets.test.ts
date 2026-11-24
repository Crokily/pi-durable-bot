import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnownSecrets, MASK, secretsOfText } from "../src/core/secrets.ts";
import { agentRequests, type FakeModel, type FakeRequest, startFakeModel } from "./support/fake-model.ts";
import { ME, TestGateway, waitFor } from "./support/gateway.ts";

// Known secrets in tool output become [secret] before the model and the log get them.

const TOKEN = "xoxb-1234567890-abcdefABCDEF";

const dirs: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "pots-secrets-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("known secrets", () => {
  it("takes the values of KEY=value files and one-value files, but not names, IDs or short values", () => {
    const env = ["# a comment", `SLACK_BOT_TOKEN=${TOKEN}`, 'export PASSWORD="hunter2-but-longer"', "SLACK_APP_ID=A0123456789", "BANK_ACCOUNT_NAME=COLIN ZHENG", "BW_CLIENTID=user.0123-4567-89ab", "BW_CLIENTSECRET=bw-secret-0123456789", "PIN=1234", "API_URL=https://api.example.com"];
    expect(secretsOfText(env.join("\n")).sort()).toEqual(["bw-secret-0123456789", "hunter2-but-longer", TOKEN].sort());
    expect(secretsOfText("raw-token-0123456789abcdef\n")).toEqual(["raw-token-0123456789abcdef"]);
    expect(secretsOfText("00000000\nshort\n")).toEqual([]);
  });

  it("takes values literally: uppercase codes, passwords that start with !, padded Base64", () => {
    const env = ["RECOVERY_CODE=ABCD2345EFGH6789", "PASSWORD=!hunter2-longer", "EMPTY_TOKEN=", "KEY=${NOT_A_REFERENCE}"];
    expect(secretsOfText(env.join("\n")).sort()).toEqual(["!hunter2-longer", "${NOT_A_REFERENCE}", "ABCD2345EFGH6789"].sort());
    expect(secretsOfText("JBSWY3DPEHPK3PXP\nc2VjcmV0LXZhbHVl\nYWJjZGVmZ2hpams=\n").sort()).toEqual(["JBSWY3DPEHPK3PXP", "YWJjZGVmZ2hpams=", "c2VjcmV0LXZhbHVl"].sort());
  });

  it("decodes a file that is not text, such as a VNC password file, and skips one it cannot decode", () => {
    const dir = folder();
    writeFileSync(join(dir, "vnc.passwd"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    writeFileSync(join(dir, "other.bin"), Buffer.from([0, 0xff, 0xfe, 3]));
    const secrets = new KnownSecrets(() => [dir], (data) => (data.length === 8 ? "decoded-0123456789" : undefined));
    expect(secrets.values()).toEqual(["decoded-0123456789"]);
  });

  it("reads a file that failed again at the next look, and keeps its last values meanwhile", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dir = folder();
    const file = join(dir, "vnc.passwd");
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    let fail = true;
    const secrets = new KnownSecrets(
      () => [file],
      () => {
        if (fail) throw new Error("EACCES");
        return TOKEN;
      },
    );
    expect(secrets.mask(TOKEN)).toBe(TOKEN);
    // Nothing about the file changed, as after a chmod.
    fail = false;
    vi.setSystemTime(Date.now() + 1_100);
    expect(secrets.mask(TOKEN)).toBe(MASK);
    fail = true;
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 5, 6, 7, 9]));
    vi.setSystemTime(Date.now() + 1_100);
    expect(secrets.mask(TOKEN)).toBe(MASK);
  });

  it("masks every known secret in text and in tool results, and keeps a result without one as it is", () => {
    const dir = folder();
    writeFileSync(join(dir, "slack.env"), `SLACK_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "shop.key"), "sk-test-0123456789\n");
    const secrets = new KnownSecrets(() => [join(dir, "shop.key"), join(dir, "slack.env"), join(dir, "missing.env")]);
    expect(secrets.mask(`token=${TOKEN} key=sk-test-0123456789.`)).toBe(`token=${MASK} key=${MASK}.`);
    const plain = { output: [{ type: "text", text: "nothing here" }], structuredOutput: { output: "nothing here", exitCode: 0 } };
    expect(secrets.maskResult(plain)).toBeUndefined();
    const leaking = { output: [{ type: "text", text: `a ${TOKEN}` }, { type: "image", data: "AAAA", mimeType: "image/png" }], structuredOutput: { output: `a ${TOKEN}`, exitCode: 0 }, diagnostics: [{ severity: "info", code: "x", message: TOKEN }] };
    const masked = secrets.maskResult(leaking)!;
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
    expect(masked.output![1]).toBe(leaking.output[1]);
    expect(masked.structuredOutput).toEqual({ output: `a ${MASK}`, exitCode: 0 });
  });

  it("masks a secret split between chunks of streamed output, and holds back only what could start one", () => {
    const dir = folder();
    writeFileSync(join(dir, "s.env"), `T=${TOKEN}\n`);
    const stream = new KnownSecrets(() => [join(dir, "s.env")]).stream();
    const parts = [stream.write("line one\nxoxb-1234"), stream.write("567890-abcdefABCDEF and x"), stream.write("ox"), stream.write("y\n"), stream.flush()];
    expect(parts.join("")).toBe(`line one\n${MASK} and xoxy\n`);
    expect(parts[0]).toBe("line one\n");
    expect(parts.join("")).not.toContain("1234");
  });

  it("reads the files again when they change, at most once a second", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dir = folder();
    const secrets = new KnownSecrets(() => [dir]);
    expect(secrets.mask(`a ${TOKEN}`)).toBe(`a ${TOKEN}`);
    writeFileSync(join(dir, "new.env"), `T=${TOKEN}\n`);
    expect(secrets.mask(`a ${TOKEN}`)).toBe(`a ${TOKEN}`);
    vi.setSystemTime(Date.now() + 1_100);
    expect(secrets.mask(`a ${TOKEN}`)).toBe(`a ${MASK}`);
  });

  it("stays cheap: 50 secrets over 50 KB of output", () => {
    const dir = folder();
    const lines = Array.from({ length: 50 }, (_, i) => `K${i}=secret-${i}-${"x".repeat(20 + i)}-${i * 7919}`);
    writeFileSync(join(dir, "many.env"), lines.join("\n"));
    const secrets = new KnownSecrets(() => [dir]);
    const text = "ordinary output line with words and numbers 12345\n".repeat(1_000);
    secrets.mask(text);
    const start = performance.now();
    for (let i = 0; i < 100; i++) secrets.mask(text);
    const each = (performance.now() - start) / 100;
    expect(each).toBeLessThan(5);
  });
});

describe("masking in a running bot", { timeout: 90_000 }, () => {
  let model: FakeModel | undefined;
  let gateway: TestGateway | undefined;
  afterEach(async () => {
    await gateway?.dispose();
    await model?.close();
  });

  it("gives the model and the log [secret] for a secret in a command's output, also split across chunks, in a script's result and in a routine's", async () => {
    const SECRET = "sk-live-0123456789ABCDEFghij";
    const CHAT_TOKEN = "chat-token-0123456789";
    // TigerVNC's vncpasswd -f for "testpw12".
    const VNC = "testpw12";
    let file = "";
    let chat = "";
    const results = (request: FakeRequest) => request.messages.filter((message) => message.role === "tool").map((message) => message.content);
    model = await startFakeModel((request) => {
      const last = request.messages.at(-1);
      if (last?.role !== "user") return { text: "done" };
      if (last.content.includes("please cat")) return { call: { name: "bash", arguments: { command: `cat '${file}'; printf 'sk-live-01234'; sleep 0.5; printf '56789ABCDEFghij\\n'` } } };
      if (last.content.includes("please look")) return { call: { name: "bash", arguments: { command: `grep -o 'chat-[a-z0-9-]*' '${chat}'; printf 'vnc ${VNC.slice(0, 6)}'; printf '${VNC.slice(6)}\\n'` } } };
      if (last.content.includes("please script")) {
        // JSON.stringify, so the backslashes of a Windows path stay in the script's string.
        return { call: { name: "codemode", arguments: { code: `const r = await tools.bash({ command: ${JSON.stringify(`cat '${file}'`)} }); return "script saw " + JSON.stringify(r);` } } };
      }
      return { text: "done" };
    });
    gateway = new TestGateway({ model });
    mkdirSync(join(gateway.home, "secrets"), { recursive: true, mode: 0o700 });
    file = join(gateway.home, "secrets", "shop.env");
    writeFileSync(file, `SHOP_API_KEY=${SECRET}\n`, { mode: 0o600 });
    // Files outside the secrets folder that bot.json names: a channel's secrets, and a VNC password file as vncpasswd
    // writes it.
    chat = join(gateway.botDir, "chat.env");
    writeFileSync(chat, `CHAT_TOKEN=${CHAT_TOKEN}\n`, { mode: 0o600 });
    const vnc = join(gateway.botDir, "vnc.passwd");
    writeFileSync(vnc, Buffer.from("f977efe6a9b36c4ef977efe6a9b36c4e", "hex"), { mode: 0o600 });
    const definition = JSON.parse(readFileSync(join(gateway.botDir, "bot.json"), "utf8")) as { channels: Record<string, unknown>[] };
    const channels = definition.channels.map((channel, i) => (i === 0 ? { ...channel, secrets: chat } : channel));
    writeFileSync(join(gateway.botDir, "bot.json"), JSON.stringify({ ...definition, channels, vnc: { port: 5900, passwordFile: vnc } }));
    await gateway.start();

    gateway.say("general", "alice", `@${ME} please cat`);
    const catted = () => agentRequests(model!).flatMap(results).find((text) => text.includes("SHOP_API_KEY"));
    await waitFor(() => catted() !== undefined, { what: "the command's result" });
    expect(catted()).toBe(`SHOP_API_KEY=${MASK}\n${MASK}\n`);

    gateway.say("general", "alice", `@${ME} please script`);
    const scripted = () => agentRequests(model!).flatMap(results).find((text) => text.includes("script saw"));
    await waitFor(() => scripted() !== undefined, { what: "the script's result" });
    expect(scripted()).toContain(`SHOP_API_KEY=${MASK}`);

    gateway.say("general", "alice", `@${ME} please look`);
    const looked = () => agentRequests(model!).flatMap(results).find((text) => text.includes("vnc "));
    await waitFor(() => looked() !== undefined, { what: "the second command's result" });
    expect(looked()).toBe(`${MASK}\nvnc ${MASK}\n`);

    // A routine that prints the secret and fails: its output is kept, and the bot woken with it, masked.
    gateway.pots("routine", "add", "leak", "--every", "1s", "--run", `cat '${file}'; exit 3`);
    const woken = () => agentRequests(model!).flatMap((request) => request.messages.filter((message) => message.role === "user").map((message) => message.content)).find((text) => text.includes("routine leak failed"));
    await waitFor(() => woken() !== undefined, { what: "the routine's failure wake" });
    gateway.pots("routine", "remove", "leak");
    expect(woken()).toContain(`SHOP_API_KEY=${MASK}`);

    for (const request of model.requests) for (const secret of [SECRET, CHAT_TOKEN, VNC]) expect(JSON.stringify(request)).not.toContain(secret);
    // Stopped, so everything it wrote is on disk; the SQLite file and its WAL.
    await gateway.kill();
    for (const name of readdirSync(gateway.botDir).filter((each) => each.startsWith("bot.sqlite"))) {
      for (const secret of [SECRET, CHAT_TOKEN, VNC]) expect(readFileSync(join(gateway.botDir, name)).includes(Buffer.from(secret)), name).toBe(false);
    }
  });
});
