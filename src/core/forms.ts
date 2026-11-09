// Forms that the bot stores with pots form add and that a button opens. Shared by the gateway, which stores them, and
// the channel adapters, which open them.

/** The platforms a form can be for. */
export type FormPlatform = "slack" | "discord";

/**
 * Which platform's format a form is in: a Slack view of type modal, or a Discord modal's data (title and components).
 * Otherwise why it is neither. Only the shape is checked; the platform checks the rest when the form opens, and the
 * bot gets its answer.
 */
export function formPlatform(form: unknown): { platform: FormPlatform } | { problem: string } {
  if (!form || typeof form !== "object" || Array.isArray(form)) return { problem: "a form is a JSON object" };
  const value = form as Record<string, unknown>;
  if (value.type === "modal") return { platform: "slack" };
  if (value.type === undefined && value.title !== undefined && Array.isArray(value.components)) return { platform: "discord" };
  return {
    problem: 'a form is a Slack view of type modal ({"type": "modal", "title": …, "blocks": […]}) or a Discord modal\'s data ({"title": …, "components": […]})',
  };
}

/** A button ID that opens a form: form:<name>, or form:<name>:<extra>, whose extra comes back with the submission. */
export function parseFormId(id: unknown): { name: string; extra?: string } | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^form:([^:]+)(?::([\s\S]*))?$/.exec(id);
  if (!match) return undefined;
  return { name: match[1]!, ...(match[2] !== undefined ? { extra: match[2] } : {}) };
}

/** Why a stored form cannot open on this platform, or undefined when it can. */
export function formMismatch(name: string, form: unknown, platform: FormPlatform): string | undefined {
  if (form === undefined) return `no form ${name} is stored (pots form list shows the forms)`;
  const found = formPlatform(form);
  if ("problem" in found) return `the form ${name} is not a form: ${found.problem}`;
  if (found.platform !== platform) return `the form ${name} is a ${found.platform === "slack" ? "Slack" : "Discord"} form, and this is ${platform === "slack" ? "Slack" : "Discord"}`;
  return undefined;
}
