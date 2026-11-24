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
  it("takes the values of env files, raw files and JSON, but not names, short values or pi's references", () => {
    const env = ["# a comment", `SLACK_BOT_TOKEN=${TOKEN}`, 'export PASSWORD="hunter2-but-longer"', "SLACK_APP_ID=A0123456789", "BANK_ACCOUNT_NAME=COLIN ZHENG", "PIN=1234", "API_URL=https://api.example.com"];
    expect(secretsOfText(env.join("\n")).sort()).toEqual(["hunter2-but-longer", TOKEN].sort());
    expect(secretsOfText("raw-token-0123456789abcdef\n")).toEqual(["raw-token-0123456789abcdef"]);
    expect(secretsOfText("00000000\nshort\n")).toEqual([]);
    const auth = {
      anthropic: { type: "oauth", access: "sk-ant-oat01-aaaaaaaaaabbbbbbbbbb", refresh: "sk-ant-ort01-ccccccccccdddddddddd", expires: 1, accountId: "acct-1234567890" },
      openai: { type: "api_key", key: "OPENAI_API_KEY" },
      other: { type: "api_key", key: "!security find-generic-password -w" },
      local: { baseUrl: "http://localhost:11434/v1", headers: { Authorization: "Bearer local-secret-123" } },
    };
    expect(secretsOfText(JSON.stringify(auth)).sort()).toEqual(["Bearer local-secret-123", "sk-ant-oat01-aaaaaaaaaabbbbbbbbbb", "sk-ant-ort01-ccccccccccdddddddddd"].sort());
  });

  it("masks every known secret in text and in tool results, and keeps a result without one as it is", () => {
    const dir = folder();
    writeFileSync(join(dir, "slack.env"), `SLACK_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ a: { key: "sk-test-0123456789" } }));
    const secrets = new KnownSecrets(() => [join(dir, "auth.json"), join(dir, "slack.env"), join(dir, "missing.env")]);
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

  it("gives the model and the log [secret] for a secret in a command's output, also split across chunks, and in a script's result", async () => {
    const SECRET = "sk-live-0123456789ABCDEFghij";
    let file = "";
    const results = (request: FakeRequest) => request.messages.filter((message) => message.role === "tool").map((message) => message.content);
    model = await startFakeModel((request) => {
      const last = request.messages.at(-1);
      if (last?.role !== "user") return { text: "done" };
      if (last.content.includes("please cat")) return { call: { name: "bash", arguments: { command: `cat '${file}'; printf 'sk-live-01234'; sleep 0.5; printf '56789ABCDEFghij\\n'` } } };
      if (last.content.includes("please script")) {
        return { call: { name: "codemode", arguments: { code: `const r = await tools.bash({ command: "cat '${file}'" }); return "script saw " + JSON.stringify(r);` } } };
      }
      return { text: "done" };
    });
    gateway = new TestGateway({ model });
    mkdirSync(join(gateway.home, "secrets"), { recursive: true, mode: 0o700 });
    file = join(gateway.home, "secrets", "shop.env");
    writeFileSync(file, `SHOP_API_KEY=${SECRET}\n`, { mode: 0o600 });
    await gateway.start();

    gateway.say("general", "alice", `@${ME} please cat`);
    const catted = () => agentRequests(model!).flatMap(results).find((text) => text.includes("SHOP_API_KEY"));
    await waitFor(() => catted() !== undefined, { what: "the command's result" });
    expect(catted()).toBe(`SHOP_API_KEY=${MASK}\n${MASK}\n`);

    gateway.say("general", "alice", `@${ME} please script`);
    const scripted = () => agentRequests(model!).flatMap(results).find((text) => text.includes("script saw"));
    await waitFor(() => scripted() !== undefined, { what: "the script's result" });
    expect(scripted()).toContain(`SHOP_API_KEY=${MASK}`);

    for (const request of model.requests) expect(JSON.stringify(request)).not.toContain(SECRET);
    // Stopped, so everything it wrote is on disk; the SQLite file and its WAL.
    await gateway.kill();
    for (const name of readdirSync(gateway.botDir).filter((each) => each.startsWith("bot.sqlite"))) {
      expect(readFileSync(join(gateway.botDir, name)).includes(Buffer.from(SECRET)), name).toBe(false);
    }
  });
});
