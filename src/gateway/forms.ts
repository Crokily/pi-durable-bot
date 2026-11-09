import { Clock, Context, Effect, Layer } from "effect";
import type { Address, FormOpening } from "../core/channel.ts";
import { type FormPlatform, formPlatform } from "../core/forms.ts";
import type { Sql } from "../core/sql.ts";
import { formatTime } from "../core/time.ts";
import { BadForm, BadName, type LogError } from "./errors.ts";
import { db } from "./log.ts";
import { nameProblem } from "./routines.ts";

/**
 * Forms the bot stored with pots form add, in the platform's own format, and what each opened form is for. A button
 * whose ID is form:<name> or form:<name>:<extra> opens the form at once, within the 3 seconds the platform gives; the
 * opening is kept here before the form opens, so its submission gets its place and message back, also after a restart.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gw_forms (
  name TEXT PRIMARY KEY,
  form TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gw_form_opens (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  form TEXT NOT NULL,
  extra TEXT,
  place TEXT,
  thread TEXT,
  message TEXT,
  person TEXT,
  data TEXT,
  opened_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gw_form_opens_at ON gw_form_opens (opened_at);
`;

/** An opening is kept this long: far longer than anyone keeps a form open. */
export const FORM_OPEN_DAYS = 30;
const DAY_MS = 86_400_000;

export interface StoredForm {
  name: string;
  platform: FormPlatform;
  /** The form's title, when it has one as plain text. */
  title?: string;
  updated_at: number;
  form: Record<string, unknown>;
}

function titleOf(form: Record<string, unknown>): string | undefined {
  const title = form.title as unknown;
  if (typeof title === "string") return title;
  if (title && typeof title === "object" && typeof (title as { text?: unknown }).text === "string") return (title as { text: string }).text;
  return undefined;
}

export class Forms extends Context.Service<
  Forms,
  {
    /** Store a form, or replace the one with the same name. */
    add(name: string, form: unknown): Effect.Effect<{ form: StoredForm; replaced: boolean }, LogError | BadName | BadForm>;
    /** False when there is no form with this name. */
    remove(name: string): Effect.Effect<boolean, LogError>;
    readonly list: Effect.Effect<StoredForm[], LogError>;
    get(name: string): Effect.Effect<Record<string, unknown> | undefined, LogError>;
    /** Keep an opening; openings older than FORM_OPEN_DAYS go. */
    opened(channel: string, id: string, opening: FormOpening): Effect.Effect<void, LogError>;
    opening(id: string): Effect.Effect<FormOpening | undefined, LogError>;
  }
>()("pots/gateway/Forms") {
  static layer(sql: Sql): Layer.Layer<Forms, LogError> {
    return Layer.effect(
      Forms,
      Effect.gen(function* () {
        yield* db(() => sql.exec(SCHEMA));
        const stored = (row: { name: string; form: string; updated_at: number }): StoredForm => {
          const form = JSON.parse(row.form) as Record<string, unknown>;
          const title = titleOf(form);
          const found = formPlatform(form);
          const platform = "platform" in found ? found.platform : "slack";
          return { name: row.name, platform, ...(title !== undefined ? { title } : {}), updated_at: row.updated_at, form };
        };
        return Forms.of({
          add: (name, form) =>
            Effect.gen(function* () {
              const problem = nameProblem(name, "form name");
              if (problem) return yield* Effect.fail(new BadName({ message: problem }));
              const found = formPlatform(form);
              if ("problem" in found) return yield* Effect.fail(new BadForm({ message: found.problem }));
              const now = yield* Clock.currentTimeMillis;
              const replaced = yield* db(async () => {
                const known = await sql.get<{ name: string }>("SELECT name FROM gw_forms WHERE name = ?", name);
                await sql.run(
                  "INSERT INTO gw_forms (name, form, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET form = excluded.form, updated_at = excluded.updated_at",
                  name,
                  JSON.stringify(form),
                  now,
                );
                return known !== undefined;
              });
              return { form: stored({ name, form: JSON.stringify(form), updated_at: now }), replaced };
            }),
          remove: (name) =>
            db(async () => (await sql.get("DELETE FROM gw_forms WHERE name = ? RETURNING 1 AS removed", name)) !== undefined),
          list: db(async () => (await sql.all<{ name: string; form: string; updated_at: number }>("SELECT name, form, updated_at FROM gw_forms ORDER BY name")).map(stored)),
          get: (name) =>
            db(async () => {
              const row = await sql.get<{ form: string }>("SELECT form FROM gw_forms WHERE name = ?", name);
              return row ? (JSON.parse(row.form) as Record<string, unknown>) : undefined;
            }),
          opened: (channel, id, opening) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              db(() =>
                sql.transaction(async (tx) => {
                  await tx.run("DELETE FROM gw_form_opens WHERE opened_at < ?", now - FORM_OPEN_DAYS * DAY_MS);
                  await tx.run(
                    `INSERT INTO gw_form_opens (id, channel, form, extra, place, thread, message, person, data, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT (id) DO UPDATE SET channel = excluded.channel, form = excluded.form, extra = excluded.extra, place = excluded.place,
                       thread = excluded.thread, message = excluded.message, person = excluded.person, data = excluded.data, opened_at = excluded.opened_at`,
                    id,
                    channel,
                    opening.form,
                    opening.extra ?? null,
                    opening.place ?? null,
                    opening.thread ?? null,
                    opening.message ?? null,
                    opening.person ?? null,
                    opening.data === undefined ? null : JSON.stringify(opening.data),
                    now,
                  );
                }),
              ),
            ),
          opening: (id) =>
            db(async () => {
              const row = await sql.get<{
                form: string;
                extra: string | null;
                place: Address | null;
                thread: Address | null;
                message: Address | null;
                person: Address | null;
                data: string | null;
              }>("SELECT form, extra, place, thread, message, person, data FROM gw_form_opens WHERE id = ?", id);
              if (!row) return undefined;
              return {
                form: row.form,
                ...(row.extra !== null ? { extra: row.extra } : {}),
                ...(row.place !== null ? { place: row.place } : {}),
                ...(row.thread !== null ? { thread: row.thread } : {}),
                ...(row.message !== null ? { message: row.message } : {}),
                ...(row.person !== null ? { person: row.person } : {}),
                ...(row.data !== null ? { data: JSON.parse(row.data) as unknown } : {}),
              };
            }),
        });
      }),
    );
  }
}

/** The forms as pots form list shows them. */
export function renderForms(forms: readonly StoredForm[]): string {
  if (forms.length === 0) return "No forms stored.";
  return forms
    .map((form) => `${form.name}: ${form.platform}${form.title !== undefined ? ` "${form.title}"` : ""}, updated ${formatTime(form.updated_at)}`)
    .join("\n");
}
