// Forms that the bot stores with pots form add and that a button opens. The gateway stores a form as it is; the
// channel adapter whose button was clicked checks that the form is in its platform's format, and opens it.

/** A button ID that opens a form: form:<name>, or form:<name>:<extra>, whose extra comes back with the submission. */
export function parseFormId(id: unknown): { name: string; extra?: string } | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^form:([^:]+)(?::([\s\S]*))?$/.exec(id);
  if (!match) return undefined;
  return { name: match[1]!, ...(match[2] !== undefined ? { extra: match[2] } : {}) };
}

/** What a click on a form: button says when no form of that name is stored. */
export function noForm(name: string): string {
  return `no form ${name} is stored (pots form list shows the forms)`;
}
