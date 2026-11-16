import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { control, printResult, resolveBot } from "./control.ts";

// Pages: web pages the bot writes in its pages/ folder, served by the gateway, with links it gives out; the password
// page, Pots' own, that writes what a person types to a file in the secrets folder; the desktop page, Pots' own, with
// which a person sees and controls the bot's screen; and the login page, Pots' own, where a person signs in to a model.

const bot = Flag.String("bot").pipe(Flag.optional, Flag.withDescription("Which bot. Default: $POTS_BOT, or the only bot."));
const person = Flag.String("for").pipe(
  Flag.optional,
  Flag.withDescription("The person the link is for, as an address. A wake then says which link was used, never who used it."),
);

const link = Command.make(
  "link",
  {
    name: Argument.String("name").pipe(Argument.withDescription("The page: a folder in the bot's pages/ with an index.html, or keep/<name>.")),
    person,
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      yield* printResult(yield* control(id, "POST", "/page/link", { page: input.name, ...(Option.isSome(input.person) ? { for: input.person.value } : {}) }));
    }),
).pipe(
  Command.withDescription(
    "Make a link to a page: JSON with the link's ID, its URL, and via (public-url or quick-tunnel). Answers sent on the page wake the bot. Each call makes a new link.",
  ),
);

const unlink = Command.make(
  "unlink",
  { link: Argument.String("link").pipe(Argument.withDescription("A link ID such as L3, S2, D1 or G1, or the link's URL.")), bot },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      yield* printResult(yield* control(id, "POST", "/page/unlink", { link: input.link }));
    }),
).pipe(Command.withDescription("Take a link back: it shows Not found from then on. A desktop or login link that is in use ends at once."));

const list = Command.make("list", { bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    yield* printResult(yield* control(id, "GET", "/page/list"));
  }),
).pipe(Command.withDescription("The bot's pages with their links, last opened and last changed, its password links, desktop links and login links."));

const secret = Command.make(
  "secret",
  {
    file: Flag.String("file").pipe(Flag.withDescription("The file in the secrets folder to write, such as slack.env.")),
    keys: Flag.String("keys").pipe(Flag.withDescription("The keys to ask for, with commas: SLACK_APP_TOKEN,SLACK_BOT_TOKEN.")),
    text: Flag.String("text").pipe(Flag.optional, Flag.withDescription("What the page says to the person: what the values are and where to find them.")),
    person,
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const body = {
        file: input.file,
        keys: input.keys
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean),
        ...(Option.isSome(input.text) ? { text: input.text.value } : {}),
        ...(Option.isSome(input.person) ? { for: input.person.value } : {}),
      };
      yield* printResult(yield* control(id, "POST", "/page/secret", body));
    }),
).pipe(
  Command.withDescription(
    "Make a password link: Pots' own page, one hidden field per key, that writes KEY=value lines to the file. It works for one submission, and for an hour. The values never reach the chat, the log or the wake.",
  ),
);

const desktop = Command.make(
  "desktop",
  {
    text: Flag.String("text").pipe(Flag.withDescription("What the person should do on your screen, and that they press Done when it is done.")),
    input: Flag.Literals("input", ["password", "code", "text"]).pipe(
      Flag.optional,
      Flag.withDescription("What the step asks them to type: their page's typing field becomes a password field (password managers fill it), a one-time code field (phones offer the code from a text message), or a text field."),
    ),
    area: Flag.String("area").pipe(
      Flag.optional,
      Flag.withDescription("x,y,width,height in your screen's pixels, such as the sign-in box: when the desktop cannot take the shape of their screen, their page starts zoomed in there."),
    ),
    minutes: Flag.Int("minutes").pipe(Flag.optional, Flag.withDescription("How long the link works after they press Start: 1 to 60. Default 15.")),
    person,
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const body = {
        text: input.text,
        ...(Option.isSome(input.input) ? { input: input.input.value } : {}),
        ...(Option.isSome(input.area) ? { area: input.area.value } : {}),
        ...(Option.isSome(input.minutes) ? { minutes: input.minutes.value } : {}),
        ...(Option.isSome(input.person) ? { for: input.person.value } : {}),
      };
      yield* printResult(yield* control(id, "POST", "/page/desktop", body));
    }),
).pipe(
  Command.withDescription(
    "Make a desktop link: Pots' own page, where one person sees and controls your screen through the VNC server of bot.json's vnc, and hands it back. Nothing shows before they press Start, and only the browser that pressed Start first can use it. It works for an hour unopened, then --minutes after Start. You are woken when they hand it back, with their note, or when it ends otherwise.",
  ),
);

const login = Command.make(
  "login",
  {
    provider: Flag.String("provider").pipe(
      Flag.optional,
      Flag.withDescription("The provider to sign in to, as pi names it, such as anthropic, openai-codex or typesafe (pots login --list shows what is signed in). Default: the person chooses."),
    ),
    text: Flag.String("text").pipe(Flag.optional, Flag.withDescription("What the page says to the person: what to sign in to, and why.")),
    person,
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const body = {
        ...(Option.isSome(input.provider) ? { provider: input.provider.value } : {}),
        ...(Option.isSome(input.text) ? { text: input.text.value } : {}),
        ...(Option.isSome(input.person) ? { for: input.person.value } : {}),
      };
      yield* printResult(yield* control(id, "POST", "/page/login", body));
    }),
).pipe(
  Command.withDescription(
    "Make a login link: Pots' own page, where one person signs in to a model provider with a subscription, or adds an API key (also TypeSafe's, for Jev), from any device, for every bot and pi on this computer. A new login replaces the provider's old one, and the page says so first. Nothing happens before they press Start, and only the browser that pressed Start first can use it. It works for an hour unopened, then 15 minutes after Start, for several logins. You are woken once for each login, with the provider and the models you can use now, never the login itself; and once at the end when nobody signed in.",
  ),
);

export const pageCommand = Command.make("page").pipe(
  Command.withDescription("Web pages the bot writes in its pages/ folder, the links to them, password pages, desktop pages and login pages."),
  Command.withSubcommands([link, unlink, list, secret, desktop, login]),
);
