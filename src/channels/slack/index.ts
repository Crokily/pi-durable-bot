import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackEvent } from "@chat-adapter/slack";
import { Chat, convertEmojiPlaceholders, defaultEmojiResolver, type Message, stringifyMarkdown } from "chat";
import type {
  Address,
  ChannelAdapter,
  ChannelConfig,
  ChannelEnv,
  ChannelSink,
  FileInfo,
  FormOpening,
  Happening,
  PersonInfo,
  PlaceInfo,
  SentMessage,
} from "../../core/channel.ts";
import { expandHome, readSecrets } from "../../core/env-file.ts";
import { noForm, parseFormId } from "../../core/forms.ts";
import { GatewaySlackAdapter, SEND_EVENT_TYPE } from "./sdk.ts";

// Addresses (only this file parses them):
//   place    <id>:#<channel ID>               slack:#C0123
//   message  <id>:#<channel ID>/<ts>          slack:#C0123/1793080260.811919  (a thread is its first message)
//   person   <id>:@<user ID>                  slack:@U0123

/**
 * What the inbox stores for this channel. An interaction has the time it came (at; older stored ones have none). A
 * click on a form: button has what became of the form: opened (with the opening's ID) or missing (why). A form's
 * submission or close has the opening it belongs to, read when it came. form-failed: a form that Slack did not open.
 */
type Raw =
  | { source: "socket"; envelope: { event_id?: string; event_time?: number; event?: SlackRawEvent } }
  | { source: "socket"; type: "interactive" | "slash_commands"; body: Record<string, any>; at?: number; form?: FormClick; opening?: FormOpening }
  | { source: "history"; channel: string; message: SlackMessage }
  | { source: "sent"; channel: string; message: SlackMessage }
  | { source: "form-failed"; at: number; body: Record<string, any>; form: FormClick; error: string };

/** A stored interaction or slash command. */
type Interaction = Extract<Raw, { source: "socket"; body: unknown }>;

/** A click on a button whose action_id is form:<name> or form:<name>:<extra>, and what became of the form. */
interface FormClick {
  name: string;
  extra?: string;
  action_id: string;
  /** The opening's ID, also in the view's private_metadata. */
  opened?: string;
  /** Why no form opened. */
  missing?: string;
}

/** What an opening keeps for Slack: the button, and the view's own private_metadata, which the opening's ID took the place of. */
interface OpeningData {
  action_id?: string;
  label?: string;
  private_metadata?: string;
}

/** The private_metadata of a view this channel opened from a stored form. */
const OPENING_PREFIX = "pots-form:";

type SlackMessage = SlackEvent & {
  subtype?: string;
  edited?: { user?: string; ts?: string };
  bot_profile?: { user_id?: string; name?: string };
  metadata?: { event_type?: string; event_payload?: { send_id?: string } };
  latest_reply?: string;
  blocks?: unknown[];
};

type SlackRawEvent = SlackMessage & {
  type?: string;
  event_ts?: string;
  message?: SlackMessage;
  previous_message?: SlackMessage;
  deleted_ts?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  inviter?: string;
};

const PLACE_TTL_MS = 60 * 60_000;
/** Slack's limit for markdown_text, in which the channel posts: https://docs.slack.dev/reference/methods/chat.postMessage */
const MAX_LENGTH = 12_000;

/** apiUrl: Slack's Web API, by default https://slack.com/api/. Only tests give another one, a fake Slack. */
export function createChannel(config: ChannelConfig, env: ChannelEnv, apiUrl?: string): ChannelAdapter {
  if (typeof config.secrets !== "string") throw new Error(`channel ${config.id}: "secrets" must name the env file with SLACK_APP_TOKEN and SLACK_BOT_TOKEN`);
  return new SlackChannel(config.id, expandHome(config.secrets), env, apiUrl);
}

class SlackChannel implements ChannelAdapter {
  readonly id: string;
  readonly #secrets: string;
  readonly #env: ChannelEnv;
  readonly #apiUrl: string | undefined;
  #sdk?: GatewaySlackAdapter;
  #botToken?: string;
  #botUserId?: string;
  readonly #places = new Map<string, { info: PlaceInfo; at: number }>();
  /** The newest logged message of each known place, by channel ID, read when the channel started: where its backfill starts. */
  #starts = new Map<string, string>();

  constructor(id: string, secrets: string, env: ChannelEnv, apiUrl: string | undefined) {
    this.id = id;
    this.#secrets = secrets;
    this.#env = env;
    this.#apiUrl = apiUrl;
  }

  get me(): PersonInfo | undefined {
    return this.#botUserId ? { address: this.person(this.#botUserId), name: this.#env.botName } : undefined;
  }

  get #client() {
    if (!this.#sdk) throw new Error(`channel ${this.id} is not started`);
    return this.#sdk.client;
  }

  async start(sink: ChannelSink): Promise<void> {
    const tokens = readSecrets(this.#secrets, ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    // Read before the socket connects: a live message logged before the backfill runs must not move its start past
    // messages that came while the gateway was down. Overlap is harmless: the log keeps a message once.
    this.#starts = new Map();
    for (const place of await sink.places()) {
      const newest = await sink.newestMessage(place);
      const parsed = newest ? this.#parse(newest) : undefined;
      if (parsed && "channel" in parsed && parsed.ts) this.#starts.set(parsed.channel, parsed.ts);
    }
    const sdk = new GatewaySlackAdapter({
      mode: "socket",
      appToken: tokens.SLACK_APP_TOKEN!,
      botToken: tokens.SLACK_BOT_TOKEN!,
      userName: this.#env.botName,
      logger: quietLogger(sink.log),
      ...(this.#apiUrl ? { apiUrl: this.#apiUrl } : {}),
    });
    sdk.onSocketEvent = async (body, type) => {
      // Slack's legacy verification token rides along in every envelope. It is not stored.
      const { token: _token, ...stored } = body as Record<string, any>;
      if (type === "events_api") {
        if (typeof stored.event_id !== "string") return;
        await sink.receive(stored.event_id, { source: "socket", envelope: stored } satisfies Raw);
        return;
      }
      const id = stored.trigger_id ?? createHash("sha256").update(JSON.stringify(stored)).digest("hex").slice(0, 32);
      const raw: Raw = { source: "socket", type: type as "interactive" | "slash_commands", body: stored, at: Date.now() };
      const open = type === "interactive" ? await this.#prepareForm(sink, raw) : undefined;
      await sink.receive(`${type}:${id}`, raw);
      // Slack takes a form only within 3 seconds of the click, so it opens now, while the click is acked.
      open?.();
    };
    sdk.onSocketError = (error) => sink.log("event not stored, Slack will deliver it again", { error: String(error) });
    // Chat holds the adapter and its in-memory state, and the adapter keeps it. No handlers: the SDK only translates.
    const chat = new Chat({ userName: this.#env.botName, adapters: { slack: sdk }, state: createMemoryState(), logger: "warn" });
    await chat.initialize();
    this.#sdk = sdk;
    this.#botToken = tokens.SLACK_BOT_TOKEN!;
    this.#botUserId = sdk.botUserId;
    if (!this.#botUserId) throw new Error("Slack did not say who the bot is");
  }

  async stop(): Promise<void> {
    await this.#sdk?.disconnect().catch(() => {});
  }

  // ---- Forms ----

  /**
   * Before an interaction is stored. A click on a form: button: when the form is stored, keep its opening under an ID
   * made from the click's trigger_id (so a click Slack delivers again has the same one), and return what opens it; the
   * view's private_metadata becomes that ID. A form's submission or close: the opening it belongs to.
   */
  async #prepareForm(sink: ChannelSink, raw: Interaction): Promise<(() => void) | undefined> {
    const body = raw.body;
    if (body.type === "view_submission" || body.type === "view_closed") {
      const metadata = body.view?.private_metadata;
      if (typeof metadata === "string" && metadata.startsWith(OPENING_PREFIX)) {
        const opening = await sink.formOpening(metadata.slice(OPENING_PREFIX.length));
        if (opening) raw.opening = opening;
      }
      return undefined;
    }
    if (body.type !== "block_actions") return undefined;
    const action = (body.actions as Record<string, any>[] | undefined)?.find((each) => parseFormId(each.action_id));
    const parsed = action && parseFormId(action.action_id);
    if (!action || !parsed) return undefined;
    const click: FormClick = { name: parsed.name, ...(parsed.extra !== undefined ? { extra: parsed.extra } : {}), action_id: action.action_id };
    raw.form = click;
    const view = await sink.form(parsed.name);
    const mismatch =
      view === undefined ? noForm(parsed.name) : view.type !== "modal" ? `the form ${parsed.name} is not a Slack view of type modal` : undefined;
    if (mismatch || typeof body.trigger_id !== "string") {
      click.missing = mismatch ?? "Slack gave no trigger_id with the click";
      return undefined;
    }
    const { private_metadata: own, ...rest } = view as Record<string, unknown>;
    const id = createHash("sha256").update(`${this.id}:${body.trigger_id}`).digest("base64url").slice(0, 24);
    click.opened = id;
    const where = this.#whereOf(body);
    const data: OpeningData = { action_id: action.action_id, ...(action.text?.text !== undefined ? { label: action.text.text } : {}), ...(typeof own === "string" ? { private_metadata: own } : {}) };
    await sink.formOpened(id, {
      form: parsed.name,
      ...(parsed.extra !== undefined ? { extra: parsed.extra } : {}),
      ...where,
      ...(body.user?.id ? { person: this.person(body.user.id) } : {}),
      data,
    });
    return () => {
      const opened = this.#client.apiCall("views.open", { trigger_id: body.trigger_id, view: { ...rest, private_metadata: `${OPENING_PREFIX}${id}` } });
      void opened.catch(async (error: unknown) => {
        const text = slackError(error).message;
        sink.log("form not opened", { form: parsed.name, error: text });
        const failed: Raw = { source: "form-failed", at: Date.now(), body, form: click, error: text };
        await sink.receive(`form-failed:${id}`, failed).catch((stored: unknown) => sink.log("form failure not stored", { form: parsed.name, error: String(stored) }));
      });
    };
  }

  /** The place, thread and message of a click on a message. */
  #whereOf(body: Record<string, any>): { place?: Address; thread?: Address; message?: Address } {
    const channel: string | undefined = body.channel?.id ?? body.container?.channel_id ?? body.channel_id;
    if (!channel) return {};
    const ts: string | undefined = body.message?.ts ?? body.container?.message_ts;
    const threadTs: string | undefined = body.message?.thread_ts ?? body.container?.thread_ts;
    return { place: this.place(channel), ...(threadTs ? { thread: this.message(channel, threadTs) } : {}), ...(ts ? { message: this.message(channel, ts) } : {}) };
  }

  owns(address: Address): boolean {
    return address.startsWith(`${this.id}:`);
  }

  // ---- Addresses ----

  placeOf(address: Address): Address | undefined {
    const parsed = this.#parse(address);
    return "channel" in parsed ? this.place(parsed.channel) : undefined;
  }

  place(channel: string): Address {
    return `${this.id}:#${channel}`;
  }

  message(channel: string, ts: string): Address {
    return `${this.id}:#${channel}/${ts}`;
  }

  person(user: string): Address {
    return `${this.id}:@${user}`;
  }

  #parse(address: Address): { channel: string; ts?: string } | { user: string } {
    if (!this.owns(address)) throw new Error(`not a ${this.id} address: ${address}`);
    const rest = address.slice(this.id.length + 1);
    const place = /^#([A-Z0-9]+)(?:\/(\d+\.\d+))?$/.exec(rest);
    if (place) return { channel: place[1]!, ...(place[2] ? { ts: place[2] } : {}) };
    const person = /^@([A-Z0-9]+)$/.exec(rest);
    if (person) return { user: person[1]! };
    throw new Error(`bad ${this.id} address: ${address}`);
  }

  // ---- Translate ----

  async translate(value: unknown): Promise<Happening[]> {
    const raw = value as Raw;
    if (raw.source === "history" || raw.source === "sent") {
      return [await this.#messageHappening({ ...raw.message, channel: raw.channel })];
    }
    if (raw.source === "form-failed") return [await this.#formFailed(raw)];
    // The options of an external select come at every keystroke, and Slack wants them in the ack, which the bot cannot
    // give. Not an event.
    if ("body" in raw && raw.body.type === "block_suggestion") return [];
    if ("body" in raw) return [await this.#interaction(raw)];
    const event = raw.envelope.event;
    if (!event) return [];
    // An event without a time of its own (member_joined_channel) has the time Slack sent it, on the envelope.
    const at = tsToMs(event.event_ts ?? event.ts ?? raw.envelope.event_time?.toString());
    switch (event.type) {
      case "message":
      case "app_mention":
        return this.#translateMessageEvent(event, at);
      case "reaction_added":
      case "reaction_removed": {
        const item = event.item ?? {};
        const place = item.channel ? await this.#placeInfo(item.channel) : undefined;
        return [
          {
            kind: event.type,
            at,
            ...(place ? { place } : {}),
            ...(item.channel && item.ts ? { message: this.message(item.channel, item.ts) } : {}),
            ...(event.user ? { person: await this.#personInfo(event.user) } : {}),
            fromMe: event.user === this.#botUserId,
            text: `:${event.reaction ?? "?"}:`,
            raw: event,
          },
        ];
      }
      case "member_joined_channel":
      case "member_left_channel": {
        if (event.channel) this.#places.delete(event.channel);
        const place = event.channel ? await this.#placeInfo(event.channel) : undefined;
        const actor = event.inviter ?? event.user;
        const inviter = event.inviter ? await this.#personInfo(event.inviter) : undefined;
        return [
          {
            kind: event.type === "member_joined_channel" ? "join" : "leave",
            at,
            ...(place ? { place } : {}),
            ...(event.user ? { person: await this.#personInfo(event.user) } : {}),
            fromMe: actor === this.#botUserId,
            ...(inviter ? { text: `invited by ${inviter.name ?? inviter.address} (${inviter.address})` } : {}),
            raw: event,
          },
        ];
      }
      default: {
        if (event.channel) this.#places.delete(event.channel);
        const place = event.channel ? await this.#placeInfo(event.channel) : undefined;
        return [
          {
            kind: event.type ?? "unknown",
            at,
            ...(place ? { place } : {}),
            ...(event.user ? { person: await this.#personInfo(event.user) } : {}),
            fromMe: event.user !== undefined && event.user === this.#botUserId,
            raw: event,
          },
        ];
      }
    }
  }

  async #translateMessageEvent(event: SlackRawEvent, at: number): Promise<Happening[]> {
    const channel = event.channel;
    if (!channel) return [];
    switch (event.subtype) {
      case "message_changed": {
        const inner = { ...event.message, channel } as SlackMessage;
        const before = event.previous_message;
        if (!inner.ts) return [];
        const author = authorOf(inner);
        const common = {
          at: tsToMs(inner.edited?.ts ?? event.event_ts ?? event.ts),
          place: await this.#placeInfo(channel),
          message: this.message(channel, inner.ts),
          ...(inner.thread_ts ? { thread: this.message(channel, inner.thread_ts) } : {}),
          fromMe: author === this.#botUserId,
          raw: inner,
        };
        const person = author ? { person: await this.#personInfo(author, inner) } : {};
        // A thread's first message, deleted while it has replies, stays as a tombstone.
        if (inner.subtype === "tombstone") return [{ kind: "delete", ...common, ...person }];
        const edited = inner.text !== before?.text || inner.edited?.ts !== before?.edited?.ts;
        // Not an edit: Slack changed the message (a link preview, the reply count). Nobody did it, so no person.
        if (!edited) return [{ kind: "update", ...common, ...files(inner) }];
        const translated = await this.#sdk!.translate(inner);
        return [{ kind: "edit", ...common, ...person, text: markdownOf(translated), mentionsMe: translated.isMention === true, mentions: this.#mentions(inner), ...files(inner) }];
      }
      case "message_deleted": {
        const before = event.previous_message;
        const ts = event.deleted_ts ?? before?.ts;
        if (!ts) return [];
        const author = before ? authorOf(before) : undefined;
        return [
          {
            kind: "delete",
            at,
            place: await this.#placeInfo(channel),
            message: this.message(channel, ts),
            ...(before?.thread_ts ? { thread: this.message(channel, before.thread_ts) } : {}),
            ...(author ? { person: await this.#personInfo(author, before) } : {}),
            fromMe: author === this.#botUserId,
            raw: event,
          },
        ];
      }
      case "message_replied": {
        const inner = event.message;
        if (!inner?.ts) return [];
        const author = authorOf(inner);
        return [
          {
            kind: "update",
            at,
            place: await this.#placeInfo(channel),
            message: this.message(channel, inner.ts),
            thread: this.message(channel, inner.thread_ts ?? inner.ts),
            fromMe: author === this.#botUserId,
            raw: inner,
          },
        ];
      }
      // The message Slack posts when someone joins. member_joined_channel comes too and gives the join. Read by a
      // backfill, the message stays: it is the only trace of a join while the gateway was down.
      case "channel_join":
        return [];
      default:
        return [await this.#messageHappening(event)];
    }
  }

  async #messageHappening(message: SlackMessage): Promise<Happening> {
    const channel = message.channel!;
    const ts = message.ts!;
    const translated = await this.#sdk!.translate(message);
    const author = authorOf(message);
    const thread = message.thread_ts ? this.message(channel, message.thread_ts) : undefined;
    const sendId = message.metadata?.event_type === SEND_EVENT_TYPE ? message.metadata.event_payload?.send_id : undefined;
    return {
      kind: "message",
      at: tsToMs(ts),
      place: await this.#placeInfo(channel),
      message: this.message(channel, ts),
      ...(thread ? { thread, threadRoot: thread } : {}),
      ...(author ? { person: await this.#personInfo(author, message) } : {}),
      fromMe: author === this.#botUserId,
      mentionsMe: translated.isMention === true,
      text: markdownOf(translated),
      mentions: this.#mentions(message),
      ...files(message),
      ...(sendId ? { sendId } : {}),
      raw: message,
    };
  }

  /**
   * A slash command or an interaction: someone used the app. A button or a menu (block_actions) says which, with its
   * label and value; a click that opened a stored form is only logged (form_opened), as its submission says more. A form's
   * submission (view_submission) is a "form" event with the values, in the place and on the message of the button that
   * opened it.
   */
  async #interaction(raw: Interaction): Promise<Happening> {
    const { type, body } = raw;
    const at = raw.at ?? Date.now();
    const user: string | undefined = body.user?.id ?? body.user_id;
    const person = user ? { person: await this.#personInfo(user) } : {};
    if (type === "slash_commands") {
      const channel: string | undefined = body.channel_id;
      return {
        kind: "command",
        at,
        ...(channel ? { place: await this.#placeInfo(channel) } : {}),
        ...person,
        fromMe: false,
        text: `${body.command ?? ""} ${body.text ?? ""}`.trim(),
        raw: body,
      };
    }
    if (body.type === "view_submission" || body.type === "view_closed") {
      const opening = raw.opening;
      const where = opening ? await this.#openingPlace(opening) : {};
      return {
        kind: body.type === "view_submission" ? "form" : "interaction",
        at,
        ...where,
        ...person,
        fromMe: false,
        text: this.#viewText(body, opening),
        raw: { ...body, ...(opening ? { pots_form: opening } : {}) },
      };
    }
    const where = this.#whereOf(body);
    const place = where.place ? { place: await this.#placeInfo(this.#channelOf(where.place)) } : {};
    const actions = ((body.actions as Record<string, any>[] | undefined) ?? []).map((action) => this.#actionText(action));
    const form = raw.form;
    let text = actions.length ? actions.join("; ") : [body.type, body.callback_id].filter(Boolean).join(" ");
    if (form?.opened) text = `opened form ${form.name} for them: ${text}`;
    else if (form?.missing) text = `${text}, and no form opened: ${form.missing}`;
    return {
      kind: form?.opened ? "form_opened" : "interaction",
      at,
      ...place,
      ...(where.thread ? { thread: where.thread } : {}),
      ...(where.message ? { message: where.message } : {}),
      ...person,
      fromMe: false,
      text,
      raw: body,
    };
  }

  /** A form that Slack did not open, with Slack's answer: a "form" event, so it reaches the bot at once. */
  async #formFailed(raw: Extract<Raw, { source: "form-failed" }>): Promise<Happening> {
    const where = this.#whereOf(raw.body);
    const user: string | undefined = raw.body.user?.id;
    const action = ((raw.body.actions as Record<string, any>[] | undefined) ?? []).find((each) => each.action_id === raw.form.action_id);
    return {
      kind: "form",
      at: raw.at,
      ...(where.place ? { place: await this.#placeInfo(this.#channelOf(where.place)) } : {}),
      ...(where.thread ? { thread: where.thread } : {}),
      ...(where.message ? { message: where.message } : {}),
      ...(user ? { person: await this.#personInfo(user) } : {}),
      fromMe: false,
      text: `the form ${raw.form.name} did not open after they ${action ? this.#actionText(action) : `clicked ${raw.form.action_id}`}. Slack said: ${raw.error}`,
      raw: { ...raw.body, pots_form_error: raw.error },
    };
  }

  /** The place, thread and message of the button that opened a form. */
  async #openingPlace(opening: FormOpening): Promise<Partial<Pick<Happening, "place" | "thread" | "message">>> {
    const ours = (address: Address | undefined) => (address && this.owns(address) ? address : undefined);
    const place = ours(opening.place);
    return {
      ...(place ? { place: await this.#placeInfo(this.#channelOf(place)) } : {}),
      ...(ours(opening.thread) ? { thread: opening.thread! } : {}),
      ...(ours(opening.message) ? { message: opening.message! } : {}),
    };
  }

  #channelOf(place: Address): string {
    const parsed = this.#parse(place);
    if (!("channel" in parsed)) throw new Error(`not a place: ${place}`);
    return parsed.channel;
  }

  /** A button or a menu as words: what was clicked or chosen, with its action_id. */
  #actionText(action: Record<string, any>): string {
    if (action.type === "button") {
      const label = action.text?.text;
      return `clicked button${label !== undefined ? ` "${label}"` : ""} (action_id ${action.action_id}${action.value !== undefined ? `, value ${action.value}` : ""})`;
    }
    return `chose in ${action.type ?? "an element"} ${action.action_id}: ${this.#valueText(action)}`;
  }

  /**
   * What a form's submission holds, one field a line (its action_id, with its block_id when two blocks share it, and
   * the input's label), or that it was closed.
   */
  #viewText(body: Record<string, any>, opening: FormOpening | undefined): string {
    const view = body.view ?? {};
    const data = (opening?.data ?? {}) as OpeningData;
    const about = opening
      ? `form ${opening.form} (${[data.label !== undefined ? `button "${data.label}"` : undefined, data.action_id ? `action_id ${data.action_id}` : undefined, opening.extra !== undefined ? `extra: ${opening.extra}` : undefined]
          .filter(Boolean)
          .join(", ")})`
      : `a form${view.callback_id ? ` with callback_id ${view.callback_id}` : ""} (view ${view.id ?? "?"})`;
    const lines = [body.type === "view_closed" ? `closed ${about} without submitting it` : `submitted ${about}`];
    if (body.type === "view_submission") {
      const labels = new Map<string, string>();
      for (const block of (view.blocks as Record<string, any>[] | undefined) ?? []) {
        if (block.block_id && block.label?.text !== undefined) labels.set(block.block_id, block.label.text);
      }
      const values = (view.state?.values ?? {}) as Record<string, Record<string, Record<string, any>>>;
      const uses = new Map<string, number>();
      for (const actions of Object.values(values)) for (const actionId of Object.keys(actions)) uses.set(actionId, (uses.get(actionId) ?? 0) + 1);
      for (const [blockId, actions] of Object.entries(values)) {
        for (const [actionId, value] of Object.entries(actions)) {
          const id = (uses.get(actionId) ?? 0) > 1 ? `${blockId}.${actionId}` : actionId;
          const label = labels.get(blockId);
          lines.push(`${id}${label !== undefined ? ` ("${label}")` : ""}: ${this.#valueText(value).replace(/\r?\n/g, "\n  ")}`);
        }
      }
    }
    const metadata = opening ? data.private_metadata : view.private_metadata;
    if (metadata) lines.push(`private_metadata: ${metadata}`);
    return lines.join("\n");
  }

  /** What a Slack input or menu holds, as text: a value, chosen options with their labels, people, places, a date. */
  #valueText(value: Record<string, any>): string {
    const none = "(none)";
    const list = (items: string[] | null | undefined, each: (item: string) => string) => (items ?? []).map(each).join(", ") || none;
    if (value.selected_option !== undefined) return optionText(value.selected_option);
    if (value.selected_options !== undefined) return (value.selected_options ?? []).map(optionText).join(", ") || none;
    if (value.selected_user !== undefined) return value.selected_user ? this.person(value.selected_user) : none;
    if (value.selected_users !== undefined) return list(value.selected_users, (user) => this.person(user));
    for (const key of ["selected_conversation", "selected_channel"]) if (value[key] !== undefined) return value[key] ? this.place(value[key]) : none;
    for (const key of ["selected_conversations", "selected_channels"]) if (value[key] !== undefined) return list(value[key], (channel) => this.place(channel));
    if (value.selected_date_time !== undefined) return value.selected_date_time ? new Date(value.selected_date_time * 1000).toISOString() : none;
    if (value.selected_date !== undefined) return value.selected_date ?? none;
    if (value.selected_time !== undefined) return value.selected_time ? `${value.selected_time}${value.timezone ? ` (${value.timezone})` : ""}` : none;
    if (value.rich_text_value !== undefined) return richText(value.rich_text_value) || "(empty)";
    if (value.files !== undefined) return ((value.files as { name?: string; id?: string }[] | null) ?? []).map((file) => file.name ?? file.id ?? "?").join(", ") || none;
    if ("value" in value) return value.value === null || value.value === undefined || value.value === "" ? "(empty)" : String(value.value);
    const { type: _type, action_id: _action, block_id: _block, action_ts: _ts, ...rest } = value;
    return JSON.stringify(rest);
  }

  #mentions(message: SlackMessage): Address[] {
    const users = new Set<string>();
    for (const match of (message.text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) users.add(match[1]!);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        if (node.type === "user" && typeof node.user_id === "string") users.add(node.user_id);
        Object.values(node).forEach(walk);
      }
    };
    walk(message.blocks);
    return [...users].map((user) => this.person(user));
  }

  async #personInfo(user: string, message?: SlackMessage): Promise<PersonInfo> {
    if (user === this.#botUserId) return this.me!;
    if (/^[UW]/.test(user)) {
      const info = await this.#sdk!.getUser(user);
      if (info) return { address: this.person(user), name: info.userName, realName: info.fullName };
    }
    const name = message?.username ?? message?.bot_profile?.name;
    return { address: this.person(user), ...(name ? { name } : {}) };
  }

  async #placeInfo(channel: string): Promise<PlaceInfo> {
    const cached = this.#places.get(channel);
    if (cached && Date.now() - cached.at < PLACE_TTL_MS) return cached.info;
    let info: PlaceInfo;
    try {
      const result = (await this.#client.conversations.info({ channel })).channel as
        | { name?: string; user?: string; is_im?: boolean; is_mpim?: boolean; purpose?: { value?: string } }
        | undefined;
      const kind = result?.is_im ? "dm" : result?.is_mpim ? "group" : "channel";
      let name = result?.name;
      if (result?.is_im && result.user) name = (await this.#personInfo(result.user)).name ?? result.user;
      info = { address: this.place(channel), kind, ...(name ? { name } : {}) };
    } catch (error) {
      this.#env.log("place lookup failed", { channel, error: String(error) });
      info = { address: this.place(channel), kind: channel.startsWith("D") ? "dm" : "channel" };
    }
    this.#places.set(channel, { info, at: Date.now() });
    return info;
  }

  // ---- Backfill ----

  /**
   * Store the messages that came while the gateway was down: in every place the bot is in, messages after the newest
   * logged one, and replies in threads with new replies. A place with nothing logged starts at the last time the
   * gateway ran. On the first start there is nothing to fill.
   */
  async backfill(sink: ChannelSink): Promise<void> {
    const client = this.#client;
    const lastAlive = sink.lastAlive();
    let added = 0;
    for await (const conversation of paginate((cursor) =>
      client.users.conversations({ types: "public_channel,private_channel,im,mpim", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) }),
    )) {
      for (const place of ((conversation as { channels?: { id?: string }[] }).channels ?? [])) {
        if (!place.id) continue;
        try {
          added += await this.#backfillPlace(sink, place.id, lastAlive);
        } catch (error) {
          // One place that cannot be read (for example a DM whose history the bot may not see) does not stop the rest.
          sink.log("backfill skipped a place", { channel: place.id, error: String(error) });
        }
      }
    }
    sink.log("backfill done", { messages: added });
  }

  async #backfillPlace(sink: ChannelSink, channel: string, lastAlive: number | undefined): Promise<number> {
    const client = this.#client;
    const since = this.#starts.get(channel) ?? (lastAlive ? (lastAlive / 1000).toFixed(6) : undefined);
    if (!since) return 0;
    let added = 0;
    const threads = new Set<string>();
    for (const address of await sink.threads(this.place(channel))) {
      const ts = (this.#parse(address) as { ts?: string }).ts;
      if (ts) threads.add(ts);
    }
    // Slack gives the newest messages first, page by page. All pages are read first, and then stored oldest first: a
    // stop in the middle then leaves no gap before the newest logged message, where the next backfill starts.
    const pages: SlackMessage[][] = [];
    for await (const page of paginate((cursor) =>
      client.conversations.history({ channel, oldest: since, inclusive: false, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }),
    )) {
      pages.push((page as { messages?: SlackMessage[] }).messages ?? []);
    }
    for (const message of pages.flat().reverse()) {
      if (!message.ts) continue;
      await sink.receive(`history:${channel}:${message.ts}:${message.edited?.ts ?? ""}`, { source: "history", channel, message } satisfies Raw);
      added++;
      if (message.latest_reply && message.latest_reply > since) threads.add(message.ts);
    }
    for (const thread of threads) {
      try {
        for await (const page of paginate((cursor) =>
          client.conversations.replies({ channel, ts: thread, oldest: since, inclusive: false, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }),
        )) {
          for (const message of ((page as { messages?: SlackMessage[] }).messages ?? [])) {
            if (!message.ts || message.ts === thread || message.ts <= since) continue;
            await sink.receive(`history:${channel}:${message.ts}:${message.edited?.ts ?? ""}`, { source: "history", channel, message } satisfies Raw);
            added++;
          }
        }
      } catch (error) {
        // A thread whose first message is gone cannot be read any more.
        if (!/thread_not_found/.test(String(error))) throw error;
      }
    }
    return added;
  }

  // ---- Send ----

  checkText(_to: Address, text: string): string | undefined {
    return refusal(this.#outgoing(text));
  }

  /** Post the text as Markdown. A text over Slack's limit is refused, never cut. */
  send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    return explained(this.#send(to, text, sendId));
  }

  async #send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const markdown = this.#outgoing(text);
    const refused = refusal(markdown);
    if (refused) throw new Error(refused);
    const { channel, threadTs } = await this.#target(to);
    const posted = await this.#sdk!.postWithSendId(this.#sdk!.threadIdFor(channel, threadTs), markdown, sendId);
    const response = posted.raw as { channel?: string; message?: SlackMessage };
    const message: SlackMessage = {
      metadata: { event_type: SEND_EVENT_TYPE, event_payload: { send_id: sendId } },
      ...(response.message ?? ({ type: "message", ts: posted.id, text, user: this.#botUserId } as SlackMessage)),
      ts: response.message?.ts ?? posted.id,
    };
    return { message: this.message(channel, message.ts!), place: this.place(channel), raw: { source: "sent", channel, message } satisfies Raw };
  }

  async findSent(to: Address, sendId: string, since: number): Promise<SentMessage | undefined> {
    const { channel, threadTs } = await this.#target(to);
    const oldest = ((since - 60_000) / 1000).toFixed(6);
    const pages = threadTs
      ? paginate((cursor) => this.#client.conversations.replies({ channel, ts: threadTs, oldest, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }))
      : paginate((cursor) => this.#client.conversations.history({ channel, oldest, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }));
    for await (const page of pages) {
      for (const message of ((page as { messages?: SlackMessage[] }).messages ?? [])) {
        if (message.metadata?.event_type === SEND_EVENT_TYPE && message.metadata.event_payload?.send_id === sendId && message.ts) {
          return { message: this.message(channel, message.ts), place: this.place(channel), raw: { source: "history", channel, message } satisfies Raw };
        }
      }
    }
    return undefined;
  }

  /** Where a send goes: a place, a thread (any message in it; replies go to its first message), or a person (DM). */
  async #target(to: Address): Promise<{ channel: string; threadTs?: string }> {
    const parsed = this.#parse(to);
    if ("user" in parsed) {
      const opened = await this.#client.conversations.open({ users: parsed.user });
      const channel = (opened.channel as { id?: string } | undefined)?.id;
      if (!channel) throw new Error(`cannot open a DM with ${to}`);
      return { channel };
    }
    if (!parsed.ts) return { channel: parsed.channel };
    const replies = await this.#client.conversations.replies({ channel: parsed.channel, ts: parsed.ts, limit: 1 }).catch(() => undefined);
    const first = (replies?.messages as SlackMessage[] | undefined)?.[0];
    return { channel: parsed.channel, threadTs: first?.thread_ts ?? parsed.ts };
  }

  /** Person and place addresses in angle brackets become Slack mentions. */
  #outgoing(text: string): string {
    const prefix = this.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text
      .replace(new RegExp(`<${prefix}:@([A-Z0-9]+)>`, "g"), "<@$1>")
      .replace(new RegExp(`<${prefix}:#([A-Z0-9]+)>`, "g"), "<#$1>");
  }

  react(message: Address, emoji: string, remove: boolean): Promise<void> {
    return explained(this.#react(message, emoji, remove));
  }

  async #react(message: Address, emoji: string, remove: boolean): Promise<void> {
    const parsed = this.#parse(message);
    if (!("channel" in parsed) || !parsed.ts) throw new Error(`not a message address: ${message}`);
    const name = reactionName(emoji);
    try {
      if (remove) await this.#client.reactions.remove({ channel: parsed.channel, timestamp: parsed.ts, name });
      else await this.#client.reactions.add({ channel: parsed.channel, timestamp: parsed.ts, name });
    } catch (error) {
      // Already there, or already gone: the reaction is as asked.
      if (!/already_reacted|no_reaction/.test(String(error))) throw error;
    }
  }

  /**
   * The content of a file of a message: its url_private, with the bot token (scope files:read). Only from Slack's own
   * hosts (in tests, the fake Slack's), so the token goes nowhere else. fetch drops the token when Slack redirects
   * to another origin.
   */
  async fetchFile(file: FileInfo, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    if (!this.#botToken) throw new Error(`channel ${this.id} is not started`);
    const url = new URL(file.url ?? "");
    const slack = url.protocol === "https:" && /(^|\.)(slack|slack-files)\.com$/.test(url.hostname);
    const fake = this.#apiUrl !== undefined && url.origin === new URL(this.#apiUrl).origin;
    if (!slack && !fake) throw new Error(`not a Slack file URL: ${url.origin}`);
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.#botToken}` }, signal });
    if (!response.ok || !response.body) throw new Error(`Slack answered ${response.status} ${response.statusText}`);
    // Without files:read, Slack answers with its sign-in page instead of the file.
    if (response.headers.get("content-type")?.startsWith("text/html") && !file.type?.startsWith("text/html")) {
      await response.body.cancel();
      throw new Error("Slack sent a web page instead of the file; the app may not have the files:read scope");
    }
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }

  /**
   * Any Slack Web API method with the bot token, for example chat.update or files.uploadV2.
   * Methods the Slack SDK implements as helpers (files.uploadV2) run through the helper; a "file" given as a path is read.
   */
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return explained(this.#call(method, params));
  }

  async #call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = this.#client;
    const parts = method.split(".");
    let owner: any = client;
    for (const part of parts.slice(0, -1)) owner = owner?.[part];
    const helper = owner?.[parts.at(-1)!];
    const args = { ...params };
    if (typeof args.file === "string") args.file = createReadStream(expandHome(args.file));
    if (Array.isArray(args.file_uploads)) {
      args.file_uploads = args.file_uploads.map((upload: Record<string, unknown>) =>
        typeof upload.file === "string" ? { ...upload, file: createReadStream(expandHome(upload.file)) } : upload,
      );
    }
    if (typeof helper === "function") return helper.call(owner, args);
    return client.apiCall(method, args);
  }
}

/**
 * A Slack error with what Slack answered: for a refused call, its error code and its details, such as which block of a
 * message is wrong (response_metadata.messages) or which scope is missing. Slack's answer holds no token.
 */
function slackError(error: unknown): Error {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (!(error instanceof Error) || !data || typeof data !== "object") return error instanceof Error ? error : new Error(String(error));
  const { ok: _ok, ...answer } = data as Record<string, unknown>;
  // The Slack SDK adds an empty response_metadata when Slack sent none.
  if (answer.response_metadata && typeof answer.response_metadata === "object" && Object.keys(answer.response_metadata).length === 0) delete answer.response_metadata;
  return new Error(`${error.message}. Slack's answer: ${JSON.stringify(answer)}`, { cause: error });
}

/** The work's result, or its failure with what Slack answered. */
async function explained<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw slackError(error);
  }
}

/** A chosen option as text: its label and its value. */
function optionText(option: { text?: { text?: string }; value?: string } | null | undefined): string {
  if (!option) return "(none)";
  const label = option.text?.text;
  return label !== undefined ? `"${label}" (value ${option.value ?? ""})` : `value ${option.value ?? ""}`;
}

/** The text of a rich text input's value: its words, a line for each section, mentions and links as Slack names them. */
function richText(value: unknown): string {
  const lines: string[] = [];
  let line = "";
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, any>;
    if (typeof item.text === "string" && (item.type === "text" || item.type === "link")) line += item.text;
    else if (item.type === "link" && typeof item.url === "string") line += item.url;
    else if (item.type === "user" && item.user_id) line += `<@${item.user_id}>`;
    else if (item.type === "channel" && item.channel_id) line += `<#${item.channel_id}>`;
    else if (item.type === "emoji" && item.name) line += `:${item.name}:`;
    if (Array.isArray(item.elements)) {
      walk(item.elements);
      if (item.type !== "rich_text") {
        lines.push(line);
        line = "";
      }
    }
  };
  walk(value);
  if (line) lines.push(line);
  return lines.filter((each) => each !== "").join("\n");
}

function authorOf(message: SlackMessage): string | undefined {
  return message.user ?? message.bot_profile?.user_id ?? message.bot_id;
}

function files(message: SlackMessage): { files?: FileInfo[] } {
  if (!message.files?.length) return {};
  return {
    files: message.files.map((file) => ({
      ...(file.name ? { name: file.name } : {}),
      ...(file.mimetype ? { type: file.mimetype } : {}),
      ...(file.url_private ? { url: file.url_private } : {}),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
    })),
  };
}

/**
 * Slack reacts by name: a name with or without colons stays, also with a skin tone (thumbsup::skin-tone-6), and an
 * emoji given as itself (👀) becomes its name.
 */
function reactionName(emoji: string): string {
  const given = emoji.trim();
  const named = /^:?([\w+-]+(?:::skin-tone-[2-6])?):?$/.exec(given)?.[1];
  if (named) return named;
  const name = defaultEmojiResolver.toSlack(defaultEmojiResolver.fromGChat(given));
  if (!/^[\w+-]+$/.test(name)) throw new Error(`unknown emoji ${given}: give its Slack name, such as eyes or white_check_mark`);
  return name;
}

/**
 * A Slack message's text as Markdown, as the other channels log theirs: a link keeps its URL, and lists, code blocks and
 * emphasis stay. The SDK's plain text drops them.
 */
function markdownOf(message: Message<unknown>): string {
  return stringifyMarkdown(message.formatted).trimEnd();
}

/** Why Slack would not take this Markdown whole: its length as Slack gets it, with mentions and emoji in Slack's form. */
function refusal(markdown: string): string | undefined {
  const length = [...convertEmojiPlaceholders(markdown, "slack")].length;
  return length > MAX_LENGTH ? `Slack allows at most ${MAX_LENGTH} characters in one message; this one has ${length}. Send it in parts.` : undefined;
}

function tsToMs(ts: string | undefined): number {
  const value = ts ? Number.parseFloat(ts) : Number.NaN;
  return Number.isFinite(value) ? Math.round(value * 1000) : Date.now();
}

async function* paginate<T extends { response_metadata?: { next_cursor?: string } }>(fetch: (cursor?: string) => Promise<T>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    yield page;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

function quietLogger(log: ChannelSink["log"]) {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, data?: unknown) => log(`slack sdk: ${message}`, { data: String(data ?? "") }),
    error: (message: string, data?: unknown) => log(`slack sdk: ${message}`, { data: String(data ?? "") }),
    child: () => logger,
  };
  return logger;
}
