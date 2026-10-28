import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/agent/agent.ts";
import type { WakeTarget } from "../src/core/wake.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { MemoryChannel, SETTINGS } from "./support/core.ts";

// The Gateway class as the bot uses it: promises in, promises out.

const target: WakeTarget = { name: "Coworker", isWorkingOn: () => false, deliver: async () => "submission", responsibilities: async () => "" };

async function openGateway() {
  const sql = await openDatabase(":memory:");
  const prints: string[] = [];
  const gateway = await Gateway.open(sql, {
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
});
