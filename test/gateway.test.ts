import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/agent/agent.ts";
import type { WakeTarget } from "../src/core/wake.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { MemoryChannel, SETTINGS } from "./support/core.ts";

// The Gateway class as the bot uses it: promises in, promises out.

const target: WakeTarget = { name: "Coworker", isWorkingOn: () => false, deliver: async () => "submission", responsibilities: async () => "" };

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error("timed out");
    await sleep(25);
  }
}

async function openGateway() {
  const sql = await openDatabase(":memory:");
  const prints: string[] = [];
  const gateway = await Gateway.open(sql, {
    bot: "coworker",
    judge: () => undefined,
    settings: () => SETTINGS,
    fallbackWakeMinutes: () => 120,
    fireTimer: async () => "timer",
    print: (message) => prints.push(message),
  });
  return { sql, gateway, prints };
}

describe("Gateway", () => {
  it("sends once per send ID and answers a repeat with the same message", async () => {
    const { sql, gateway } = await openGateway();
    const channel = new MemoryChannel();
    await gateway.start(target, [channel]);
    const first = await gateway.send("id-1", "mem:#general", "hello");
    const again = await gateway.send("id-1", "mem:#general", "hello");
    expect(again).toEqual({ ...first, repeated: true });
    expect(channel.platform).toHaveLength(1);
    await gateway.stop();
    await sql.close();
  });

  it("rejects with the messages the agent knows", async () => {
    const { sql, gateway } = await openGateway();
    await gateway.start(target, [new MemoryChannel()]);
    await expect(gateway.send("id", "mem:#general", "  ")).rejects.toThrow("text is empty");
    await expect(gateway.send("id", "nope:#x", "hi")).rejects.toThrow('no channel for address "nope:#x". Copy addresses from a wake message or the log.');
    expect(() => gateway.channel("slack")).toThrow('unknown channel "slack"; channels: mem');
    await expect(gateway.addChannel(new MemoryChannel())).rejects.toThrow("channel mem is already running");
    await gateway.stop();
    await sql.close();
  });

  it("can be stopped twice, and says so to calls after the stop", async () => {
    const { sql, gateway, prints } = await openGateway();
    await gateway.start(target, [new MemoryChannel()]);
    await Promise.all([gateway.stop(), gateway.stop()]);
    await gateway.stop();
    await expect(gateway.send("id", "mem:#general", "hi")).rejects.toThrow("the gateway is stopped");
    await expect(gateway.timers.pending()).rejects.toThrow("the gateway is stopped");
    expect(() => gateway.adapterFor("mem:#general")).toThrow("the gateway is stopped");
    expect(prints.filter((message) => /failed/.test(message))).toEqual([]);
    await sql.close();
  });

  it("writes one trace for a wake and the messages the agent sends for it", async () => {
    const { sql, gateway } = await openGateway();
    const channel = new MemoryChannel();
    const wakes: string[] = [];
    await gateway.start({ ...target, deliver: async (wake) => (wakes.push(wake.id), "submission-1") }, [channel]);

    await channel.sink!.receive("e1", { id: "e1", place: "general", text: "@bot hello", person: "alice" });
    await until(() => wakes.length === 1);
    await gateway.send("tool:1", "mem:#general", "on it", ["submission-1"]);
    await gateway.stop();

    const spans = await sql.all<{ name: string; trace_id: string; span_id: string; parent_id: string | null; status: string; attributes: string; links: string }>(
      "SELECT name, trace_id, span_id, parent_id, status, attributes, links FROM gw_spans ORDER BY start_at, rowid",
    );
    const wake = spans.find((span) => span.name === "wake")!;
    const trace = spans.filter((span) => span.trace_id === wake.trace_id);
    const byId = new Map(trace.map((span) => [span.span_id, span]));
    const path = (span: (typeof trace)[number]): string => (span.parent_id && byId.has(span.parent_id) ? `${path(byId.get(span.parent_id)!)} > ${span.name}` : span.name);
    expect(trace.map(path).sort()).toEqual([
      "wake",
      "wake > send",
      "wake > send > channel.send",
      "wake > send > inbox.receive",
      "wake > send > inbox.receive > inbox.apply",
      "wake > wake.deliver",
    ]);
    expect(JSON.parse(wake.attributes)).toMatchObject({ reason: "mention", place: "mem:#general", submission: "submission-1" });
    expect(JSON.parse(trace.find((span) => span.name === "send")!.attributes)).toMatchObject({ send: "tool:1", result: "sent" });
    // The wake links to the span that logged its event.
    const [link] = JSON.parse(wake.links) as { span_id: string }[];
    expect(spans.find((span) => span.span_id === link!.span_id)?.name).toBe("inbox.apply");
    expect(trace.every((span) => span.status === "ok")).toBe(true);
    await sql.close();
  });

  it("deletes spans older than 7 days when it starts", async () => {
    const { sql, gateway } = await openGateway();
    await gateway.stop();
    await sql.run("INSERT INTO gw_spans (span_id, trace_id, name, start_at, end_at, status) VALUES ('old', 'old', 'wake', ?, ?, 'ok')", Date.now() - 8 * 86_400_000, Date.now());
    await sql.run("INSERT INTO gw_spans (span_id, trace_id, name, start_at, end_at, status) VALUES ('new', 'new', 'wake', ?, ?, 'ok')", Date.now() - 6 * 86_400_000, Date.now());
    const again = await Gateway.open(sql, { bot: "coworker", judge: () => undefined, settings: () => SETTINGS, fallbackWakeMinutes: () => 120, fireTimer: async () => "t", print: () => {} });
    await again.stop();
    expect((await sql.all<{ span_id: string }>("SELECT span_id FROM gw_spans WHERE span_id IN ('old', 'new')")).map((row) => row.span_id)).toEqual(["new"]);
    await sql.close();
  });

  it("also exports the spans over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
    const received: { resource: Record<string, unknown>; spans: { name: string; traceId: string; spanId: string; parentSpanId?: string }[] }[] = [];
    const collector = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        if (req.url === "/v1/traces") {
          for (const resourceSpans of (JSON.parse(body) as { resourceSpans: any[] }).resourceSpans) {
            const resource = Object.fromEntries(resourceSpans.resource.attributes.map((item: any) => [item.key, Object.values(item.value)[0]]));
            received.push({ resource, spans: resourceSpans.scopeSpans.flatMap((scope: any) => scope.spans) });
          }
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
    try {
      const { sql, gateway } = await openGateway();
      const channel = new MemoryChannel();
      await gateway.start({ ...target, deliver: async () => "submission-1" }, [channel]);
      await channel.sink!.receive("e1", { id: "e1", place: "general", text: "@bot hello", person: "alice" });
      await sleep(3_200);
      await gateway.send("tool:1", "mem:#general", "on it", ["submission-1"]);
      await gateway.stop();

      const exported = received.flatMap((batch) => batch.spans);
      expect(received[0]?.resource).toMatchObject({ "service.name": "pots", "pots.bot": "coworker" });
      const stored = await sql.all<{ name: string; trace_id: string; span_id: string; parent_id: string | null }>("SELECT name, trace_id, span_id, parent_id FROM gw_spans");
      // The same spans, with the same IDs and parents, in both places.
      const key = (name: string, traceId: string, spanId: string, parent: string | null | undefined) => `${name} ${traceId} ${spanId} ${parent || "-"}`;
      expect(new Set(exported.map((span) => key(span.name, span.traceId, span.spanId, span.parentSpanId)))).toEqual(
        new Set(stored.map((span) => key(span.name, span.trace_id, span.span_id, span.parent_id))),
      );
      expect(exported.map((span) => span.name)).toEqual(expect.arrayContaining(["wake", "wake.deliver", "send", "channel.send", "inbox.apply"]));
      await sql.close();
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      collector.close();
    }
  });

  it("joins a send to a wake from before a restart", async () => {
    const { sql, gateway } = await openGateway();
    const channel = new MemoryChannel();
    let woken = false;
    await gateway.start({ ...target, deliver: async () => ((woken = true), "submission-7") }, [channel]);
    await channel.sink!.receive("e1", { id: "e1", place: "general", text: "@bot hello", person: "alice" });
    await until(() => woken);
    await gateway.stop();

    const again = await Gateway.open(sql, { bot: "coworker", judge: () => undefined, settings: () => SETTINGS, fallbackWakeMinutes: () => 120, fireTimer: async () => "t", print: () => {} });
    await again.start(target, [new MemoryChannel()]);
    await again.send("tool:9", "mem:#general", "after the restart", ["submission-7"]);
    await again.stop();
    const traces = await sql.all<{ name: string; trace_id: string }>("SELECT name, trace_id FROM gw_spans WHERE name IN ('wake', 'send')");
    expect(new Set(traces.map((span) => span.trace_id)).size).toBe(1);
    await sql.close();
  });
});
