import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { control, printResult, resolveBot } from "./control.ts";

// Pages: web pages the bot writes in its pages/ folder, served by the gateway, with links it gives out; and the password
// page, Pots's own, that writes what a person types to a file in the secrets folder.

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
  { link: Argument.String("link").pipe(Argument.withDescription("A link ID such as L3 or S2, or the link's URL.")), bot },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      yield* printResult(yield* control(id, "POST", "/page/unlink", { link: input.link }));
    }),
).pipe(Command.withDescription("Take a link back: it shows Not found from then on."));

const list = Command.make("list", { bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    yield* printResult(yield* control(id, "GET", "/page/list"));
  }),
).pipe(Command.withDescription("The bot's pages with their links, last opened and last changed, and its password links."));

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
    "Make a password link: Pots's own page, one hidden field per key, that writes KEY=value lines to the file. It works for one submission, and for an hour. The values never reach the chat, the log or the wake.",
  ),
);

export const pageCommand = Command.make("page").pipe(
  Command.withDescription("Web pages the bot writes in its pages/ folder, the links to them, and password pages."),
  Command.withSubcommands([link, unlink, list, secret]),
);
