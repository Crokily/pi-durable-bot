import type { InboxState, LiveState, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type CallTask, type ChildInfo, childActivity, describeChild } from "../src/agent/children.ts";

// How a working child is described from its conversation's live state, on its own: the gateway tests in
// children.test.ts show the same lines from outside, for a command that hangs.

const NOW = 1_800_000_000_000;
const task = (id: number) => id as TaskId;
const child: ChildInfo = { id: "c5", title: "Remote desktop", conversationId: "7", place: "slack:#C1", thinking: "xhigh", startedAt: NOW - 9_720_000, since: NOW - 9_720_000 };
const inbox = (steers: number): InboxState => ({
  items: [
    ...Array.from({ length: steers }, (_, index) => ({ id: index + 1, mode: "steer" as const, content: "message" })),
    { id: 99, mode: "write" as const, entry: { kind: "note" } },
  ] as InboxState["items"],
});
const described = (live: LiveState, options: { inbox?: InboxState; tasks?: Record<string, CallTask>; outputs?: Record<string, number | undefined> } = {}) =>
  describeChild(
    { ...child, activity: childActivity(live, options.inbox, new Map(Object.entries(options.tasks ?? {})), new Map(Object.entries(options.outputs ?? {}))) },
    NOW,
  );

describe("describing a working child", () => {
  it("gives the tool call it is in, for how long, the start of its command, its last line of output and its age, and the messages that wait", () => {
    const live: LiveState = {
      tools: [
        { callId: "a", name: "read", taskId: task(40), status: "done" },
        { callId: "b", name: "bash", taskId: task(41), status: "running", output: "connecting\n\x1b[32mRFB 003.008\x1b[0m\r\n\n" },
      ],
    };
    const text = described(live, {
      inbox: inbox(2),
      tasks: { "41": { startedAt: NOW - 9_000_000, arguments: { command: "cd /tmp/rdtest &&\n  node rfbping.mjs 127.0.0.1 5901", timeout: 0 } } },
      outputs: { "41": NOW - 8_940_000 },
    });
    expect(text).toBe(
      [
        'c5 "Remote desktop": working, for 2.7 h, for slack:#C1',
        "  In bash for 2.5 h: cd /tmp/rdtest && node rfbping.mjs 127.0.0.1 5901",
        "  Last output 2.5 h ago: RFB 003.008",
        "  2 messages from you wait until its current tool calls end.",
      ].join("\n"),
    );
  });

  it("shows a progress line as a terminal does, cuts long text, and says when a command gave no output yet", () => {
    const long = `node crawl.mjs ${"x".repeat(300)}`;
    const live: LiveState = {
      tools: [
        { callId: "a", name: "bash", taskId: task(1), status: "running", output: "downloading 10%\rdownloading 55%\r" },
        { callId: "b", name: "bash", taskId: task(2), status: "running" },
      ],
    };
    const lines = described(live, {
      tasks: { "1": { startedAt: NOW - 30_000, arguments: { command: "curl -O big.iso" } }, "2": { startedAt: NOW - 30_000, arguments: { command: long } } },
      outputs: { "1": NOW - 1_000, "2": undefined },
    }).split("\n");
    expect(lines.slice(1)).toEqual([
      "  In bash for 30 s: curl -O big.iso",
      "  Last output 1 s ago: downloading 55%",
      `  In bash for 30 s: ${long.slice(0, 149)}…`,
      "  No output yet.",
    ]);
  });

  it("gives the call a script makes now, with that call's output", () => {
    const live: LiveState = {
      tools: [{ callId: "c", name: "codemode", taskId: task(10), status: "running" }],
      nestedTools: [
        { callId: "c/1", parentCallId: "c", parentTaskId: task(10), taskId: task(11), name: "read", status: "done", arguments: { path: "a.txt" } },
        { callId: "c/2", parentCallId: "c", parentTaskId: task(10), taskId: task(12), name: "bash", status: "running", arguments: { command: "sleep 999" }, output: "waiting\n" },
      ],
    };
    const lines = described(live, {
      tasks: { "10": { startedAt: NOW - 600_000, arguments: { code: "const out = await tools.bash({ command: 'sleep 999' });\nreturn out;" } }, "12": { startedAt: NOW - 540_000 } },
      outputs: { "10": undefined, "12": NOW - 540_000 },
    }).split("\n");
    expect(lines.slice(1)).toEqual([
      "  In codemode for 10 min: const out = await tools.bash({ command: 'sleep 999' }); return out;",
      "  Its script is in bash for 9 min: sleep 999",
      "  Last output 9 min ago: waiting",
    ]);
  });

  it("says when its model answers, fails and tries again, or the child compacts, and when waiting messages reach it then", () => {
    expect(described({ generation: { attempt: 1 } }, { inbox: inbox(1) }).split("\n").slice(1)).toEqual([
      "  Its model is answering.",
      "  1 message from you waits until it answers, or until the tool calls of its next step end.",
    ]);
    expect(described({ generation: { attempt: 3, retry: { at: NOW + 20_000, error: "429 rate limited:\ntry later" } } }).split("\n").slice(1)).toEqual([
      "  Its model's last request failed (429 rate limited: try later); it tries again in 20 s.",
    ]);
    expect(described({ compactions: [{ taskId: task(3) as never, trigger: "threshold", blocking: true, attempt: 1 }] }).split("\n").slice(1)).toEqual([
      "  It is compacting its context.",
    ]);
  });

  it("adds nothing for a child that waits for a message or was stopped", () => {
    const activity = childActivity({ generation: { attempt: 1 } }, inbox(1), new Map(), new Map());
    const { since: _, ...waiting } = child;
    expect(describeChild({ ...waiting, endedAt: NOW - 60_000, activity }, NOW)).toBe('c5 "Remote desktop": ended 1 min ago, waits for a message, for slack:#C1');
    expect(describeChild({ ...waiting, stoppedAt: NOW - 60_000, activity }, NOW)).toBe('c5 "Remote desktop": stopped 1 min ago, for slack:#C1');
  });
});
