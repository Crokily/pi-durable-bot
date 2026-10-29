import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, coworker, type FakeModel, type FakeRequest, startFakeModel } from "./support/fake-model.ts";
import { ME, TestGateway, waitFor } from "./support/gateway.ts";

// What the agent gets as a pi session would, seen from outside: AGENTS.md and skills found the way the pi CLI finds
// them, and images that read shrinks to fit the model.

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

const lastPrompt = () => agentRequests(model).at(-1)!.system;

function skill(dir: string, name: string, description: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
  return file;
}

/** A black grayscale PNG of this size. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const rows = Buffer.alloc((width + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

describe("pi's context files, skills and images", { timeout: 90_000 }, () => {
  it("finds AGENTS.md and skills as pi does, again before each request, and renames persona.md", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model });
    writeFileSync(join(gateway.botDir, "persona.md"), "I keep it short.\n");
    writeFileSync(join(gateway.home, "pi", "AGENTS.md"), "Everyone here uses metric units.\n");
    const release = skill(join(gateway.home, "pi", "skills"), "release-notes", "Write release notes. Use when a version ships.");
    await gateway.start();
    const agents = join(gateway.botDir, "AGENTS.md");
    expect(readFileSync(agents, "utf8")).toBe("I keep it short.\n");
    expect(existsSync(join(gateway.botDir, "persona.md"))).toBe(false);

    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    const first = lastPrompt();
    expect(first).toContain("<project_context>");
    // pi's order: the global file, then from the root down to the working directory.
    expect(first.indexOf("Everyone here uses metric units.")).toBeLessThan(first.indexOf(`<project_instructions path="${agents}">\nI keep it short.`));
    expect(first).toContain(`<name>release-notes</name>\n    <description>Write release notes. Use when a version ships.</description>\n    <location>${release}</location>`);

    writeFileSync(agents, "I keep it short. I answer in French.\n");
    const deploy = skill(join(gateway.botDir, "workspace", ".agents", "skills"), "deploy", "Deploy the app. Use when asked to ship.");
    gateway.say("general", "alice", `@${ME} and now?`);
    await waitFor(() => gateway.sent().length === 2, { what: "the second reply" });
    const second = lastPrompt();
    expect(second).toContain("I answer in French.");
    expect(second).toContain(`<location>${deploy}</location>`);
  });

  it("shrinks a screenshot larger than the model takes, as pi does", async () => {
    let image = "";
    const script = (request: FakeRequest) => {
      const last = request.messages.at(-1);
      if (last?.role === "user" && last.content.startsWith("[wake]")) return { call: { name: "read", arguments: { path: image } } };
      return coworker(request);
    };
    model = await startFakeModel(script);
    gateway = new TestGateway({ model });
    // A Retina screenshot; the model takes at most 2000x2000.
    image = join(gateway.home, "screen.png");
    writeFileSync(image, png(3024, 1964));
    await gateway.start();
    gateway.say("general", "alice", `@${ME} look at the screen`);
    await waitFor(() => agentRequests(model).some((request) => request.messages.some((message) => message.role === "tool")), { what: "the read result" });
    const after = agentRequests(model).find((request) => request.messages.some((message) => message.role === "tool"))!;
    expect(after.messages.filter((message) => message.role === "tool").map((message) => message.content).join("")).not.toMatch(/image processor|larger than/);
    expect(after.messages.reduce((sum, message) => sum + message.images, 0)).toBe(1);
  });
});
