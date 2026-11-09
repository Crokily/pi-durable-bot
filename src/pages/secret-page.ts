import type { SecretView } from "./store.ts";

// The password page: Pots's own HTML, never the bot's. A plain form and no script, so it works in the strictest sandbox.

/**
 * The headers that keep the password page apart from the bot's pages, which share its address: the browser gives it an
 * origin of its own (sandbox without allow-same-origin), so a bot page's script cannot read what is typed; nothing loads
 * from anywhere, no script runs, and no page can frame it.
 */
export const SECRET_PAGE_HEADERS = {
  "content-security-policy": "sandbox allow-forms; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cache-control": "no-store",
} as const;

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const STYLE = `
:root { color-scheme: light dark; --fg: #1d2321; --muted: #5b6662; --line: #d5dbd8; --bg: #f7f8f7; --card: #fff; --accent: #1f7a70; --warn-bg: #fff6e0; --warn-fg: #6b4a00; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8ecea; --muted: #a3aeaa; --line: #3a4441; --bg: #141917; --card: #1d2421; --accent: #4fb3a6; --warn-bg: #3a2f12; --warn-fg: #f3d58a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 34rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.3rem; line-height: 1.3; margin: 0 0 1rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; }
.text { white-space: pre-wrap; margin: 0 0 1rem; }
label { display: block; font-weight: 600; margin: 1rem 0 0.35rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95rem; word-break: break-all; }
input { width: 100%; font: inherit; padding: 0.7rem 0.8rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { margin-top: 1.25rem; width: 100%; font: inherit; font-weight: 600; padding: 0.8rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; }
.facts { color: var(--muted); font-size: 0.9rem; margin: 1rem 0 0; }
.warn { background: var(--warn-bg); color: var(--warn-fg); border-radius: 8px; padding: 0.75rem 0.9rem; font-size: 0.9rem; margin: 1rem 0 0; }
.problem { color: #b3261e; font-weight: 600; margin: 0 0 0.5rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

/** What the person sees while the link is open: one masked field per key, and the facts about where the values go. */
export function renderSecretForm(link: SecretView, botName: string, options: { quickTunnel: boolean; now: number; problem?: string }): string {
  const minutes = Math.max(1, Math.ceil((link.expiresAt - options.now) / 60_000));
  const fields = link.keys
    .map(
      (key, index) =>
        `<label for="k${index}">${escape(key)}</label><input id="k${index}" name="${escape(key)}" type="password" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`,
    )
    .join("\n");
  const warn = options.quickTunnel
    ? `<p class="warn">This page reaches ${escape(botName)} through a Cloudflare Quick Tunnel, so Cloudflare can see what you type here. For a private connection, ask ${escape(botName)} to set up Tailscale Funnel first.</p>`
    : "";
  return page(
    `${botName} asks for ${link.keys.length === 1 ? "a secret" : "secrets"}`,
    `<h1>${escape(botName)} asks for ${link.keys.length === 1 ? "a secret value" : `${link.keys.length} secret values`}</h1>
<div class="card">
${options.problem ? `<p class="problem">${escape(options.problem)}</p>` : ""}${link.text ? `<p class="text">${escape(link.text)}</p>` : ""}
<form method="post" accept-charset="utf-8" autocomplete="off">
${fields}
<button type="submit">Save (this link works once)</button>
</form>
<p class="facts">What you type goes only to the file ${escape(link.file)} in the secrets folder on ${escape(botName)}'s computer. It does not go into the chat. ${escape(botName)} is told which keys came, not their values. This link expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.</p>
${warn}
</div>`,
  );
}

export const renderSecretSaved = (link: SecretView, botName: string) =>
  page(
    "Saved",
    `<h1>Saved</h1><div class="card"><p>${escape(link.keys.join(", "))} ${link.keys.length === 1 ? "was" : "were"} written to ${escape(link.file)}. ${escape(botName)} was told which keys came, not their values. You can close this page.</p></div>`,
  );

export const renderSecretUsed = () => page("Link already used", `<h1>This link was already used</h1><div class="card"><p>Each password link works once. Ask for a new link if you need to change a value.</p></div>`);

export const renderSecretExpired = () => page("Link expired", `<h1>This link expired</h1><div class="card"><p>A password link works for one hour. Ask for a new link.</p></div>`);

export const renderNotFound = () => page("Not found", `<h1>Not found</h1><div class="card"><p>This link does not exist, or it was taken back.</p></div>`);

export const renderFailed = (reason: string) => page("Not saved", `<h1>Not saved</h1><div class="card"><p>${escape(reason)}</p><p>Try again in a moment.</p></div>`);
