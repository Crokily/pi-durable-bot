import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// A model server for tests: it speaks the OpenAI chat completions API, so a real gateway process uses it through pi's
// model layer like any OpenAI-compatible endpoint. Its answers come from a script, not from a model.

export interface FakeRequest {
  /** The system prompt. */
  readonly system: string;
  readonly messages: readonly { role: string; content: string; toolCalls?: readonly string[] }[];
  readonly tools: readonly string[];
}

export type FakeReply = { readonly text: string } | { readonly call: { readonly name: string; readonly arguments: Record<string, unknown> } };

export interface FakeModel {
  /** The base URL, for models.json. */
  readonly url: string;
  /** Every request so far, in order. */
  readonly requests: FakeRequest[];
  close(): Promise<void>;
}

export async function startFakeModel(script: (request: FakeRequest) => FakeReply = coworker): Promise<FakeModel> {
  const requests: FakeRequest[] = [];
  let calls = 0;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readBody(req)) as { stream?: boolean; messages: OpenAiMessage[]; tools?: { function: { name: string } }[] };
      const request = toRequest(body);
      requests.push(request);
      const reply = script(request);
      const id = `fake-${++calls}`;
      const delta = "text" in reply
        ? { role: "assistant", content: reply.text }
        : { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.arguments) } }] };
      const finish = "text" in reply ? "stop" : "tool_calls";
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
      if (body.stream === false) {
        const { role, ...rest } = delta;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, message: { role, content: null, ...rest }, finish_reason: finish }], usage }));
        return;
      }
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "fake", choices, ...extra })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk([{ index: 0, delta, finish_reason: null }]));
      res.write(chunk([{ index: 0, delta: {}, finish_reason: finish }]));
      res.write(chunk([], { usage }));
      res.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The first line of a wake message, which says why the bot was woken: "[wake] someone mentioned you". */
export function wakeLine(text: string): string {
  return text.split("\n")[0]!;
}

/** Requests that came from the agent, not from the judge. */
export function agentRequests(model: FakeModel): FakeRequest[] {
  return model.requests.filter((request) => !isJudge(request));
}

/** The wake messages the agent got, in order: the last user message of each agent request that starts a run. */
export function wakes(model: FakeModel): string[] {
  return agentRequests(model)
    .map((request) => request.messages.at(-1))
    .filter((message) => message?.role === "user")
    .map((message) => message!.content);
}

/**
 * A plain coworker. The judge says yes to new events that talk about pricing. The agent answers a wake with one message
 * in the wake's place, "ack: <first line of the wake>", and then stops.
 */
export function coworker(request: FakeRequest): FakeReply {
  if (isJudge(request)) {
    const state = JSON.parse(request.messages.at(-1)?.content ?? "{}") as { state?: { new_events?: { text?: string }[] } };
    const yes = (state.state?.new_events ?? []).some((event) => /pricing/i.test(event.text ?? ""));
    return { text: JSON.stringify({ related: yes ? 0.9 : 0.1, respond: yes ? 0.9 : 0.1 }) };
  }
  const last = request.messages.at(-1);
  if (last?.role !== "user") return { text: "done" };
  // The first address of a place in the wake, for example "test:#general".
  const place = /\b[a-z0-9][a-z0-9-]*:#[\w-]+/.exec(last.content)?.[0];
  if (!place) return { text: "nothing to do" };
  return { call: { name: "send", arguments: { to: place, text: `ack: ${wakeLine(last.content)}` } } };
}

function isJudge(request: FakeRequest): boolean {
  return request.system.startsWith("You judge events");
}

interface OpenAiMessage {
  role: string;
  content: string | { type: string; text?: string }[] | null;
  tool_calls?: { function: { name: string } }[];
}

function toRequest(body: { messages: OpenAiMessage[]; tools?: { function: { name: string } }[] }): FakeRequest {
  const text = (content: OpenAiMessage["content"]) =>
    typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
  const system = body.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => text(message.content)).join("\n");
  return {
    system,
    messages: body.messages
      .filter((message) => message.role !== "system" && message.role !== "developer")
      .map((message) => ({
        role: message.role,
        content: text(message.content),
        ...(message.tool_calls ? { toolCalls: message.tool_calls.map((call) => call.function.name) } : {}),
      })),
    tools: (body.tools ?? []).map((tool) => tool.function.name),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
