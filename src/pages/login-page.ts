import { isLongText, type Lang, possessive, textHtml } from "./desktop-page.ts";
import type { LoginView } from "./login.ts";

// The login page: Pots' own HTML, never the bot's. The page is a shell: kit/login/login.js shows pi's questions and
// events, and talks to Pots under the link's path (state, start, login, answer, cancel, done). What the bot wrote shows
// only as text. The page's words come from here, in the person's language when Pots has it.

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/**
 * The page's words. {bot}, {provider}, {time} and the like are filled in where they are used; {bots} is the bot's name
 * with the possessive, as English writes it.
 */
const WORDS = {
  en: {
    title: "Sign in for {bot}",
    asks: "{bot} asks you to sign in to a model",
    asksProvider: "{bot} asks you to sign in to {provider}",
    linkUntil: "The link works until {time}",
    afterStart: "{n} minutes after Start",
    whatTitle: "What this link can do",
    what: "It signs {bots} computer in to a model provider, with your subscription or API key, for every bot and pi program on that computer. A new login replaces the one that is there for that provider. Nothing happens before you press Start, and only the first device that presses Start can use the link. {bot} is told which provider you signed in to and which models it can use, never your key, code or account.",
    tunnel: "This page goes through Cloudflare's free tunnel, so Cloudflare can see what is shown and typed here. A device code is safe. With a code or an address pasted here, or an API key typed here, Cloudflare could finish the sign-in or use the key.",
    start: "Start",
    continue: "Continue",
    elsewhere: "This link is open on another device. Only the device that pressed Start first can use it.",
    network: "No connection to {bot}. Check your network and try again.",
    noscript: "This page needs JavaScript.",
    subscription: "Subscription",
    subscriptionNote: "ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more",
    apiKey: "API key",
    apiKeyNote: "Any provider, also TypeSafe for the Jev judge",
    search: "Search providers",
    noMatch: "No provider matches.",
    there: "signed in now",
    replaceTitle: "Replace the {provider} login?",
    replaceText: "{bots} computer has a {provider} login now. Signing in replaces it, for every bot and pi program on that computer.",
    replaceGo: "Sign in and replace",
    back: "Back",
    signingIn: "Signing in to {provider}",
    cancel: "Cancel",
    openSignIn: "Open the sign-in page",
    deviceCode: "Enter this code at {host}",
    copy: "Copy",
    copied: "Copied",
    openSite: "Open {host}",
    codeUntil: "The code works until {time}",
    pasteHint: "When you are signed in, the provider shows a code, or the browser ends on a page that cannot load (its address starts with http://localhost or http://127.0.0.1). Copy that code, or the page's whole address, and paste it here.",
    recommended: "works from this device",
    hidden: "Not offered here, since they must be set up on the computer itself: {ways}. {bot} can do that on its computer; ask it in the chat.",
    secretWarn: "Cloudflare can see what you type here, as on the password page. For a private connection, ask {bot} to set up Tailscale Funnel first.",
    codeWarn: "Cloudflare can see what you paste here, and the sign-in link above: that can be enough to finish this sign-in in your name. For a private connection, ask {bot} to set up Tailscale Funnel first.",
    send: "Continue",
    empty: "It cannot be empty.",
    gone: "pi moved on; here is where it is now.",
    signedIn: "Signed in to {provider}",
    replaced: "It replaced the login that was there.",
    ready: "Ready: {model}",
    notAnswer: "{model} did not answer: {reason}",
    judgeReady: "Ready as a judge: {model}",
    noModels: "pi lists no model for this login.",
    failed: "Not signed in to {provider}",
    cancelled: "Cancelled.",
    another: "Sign in to another",
    tryAgain: "Try again",
    done: "Done",
    doneNote: "{bot} is told about each login. Press Done when you have finished.",
    working: "Working…",
    oneMinute: "1 minute left",
    endedDone: "All set",
    endedDoneText: "You can close this page. {bot} knows what you signed in to.",
    endedExpired: "This link has ended",
    endedExpiredText: "Ask {bot} for a new link if you still need to sign in.",
    endedRevoked: "{bot} took this link back",
    endedRevokedText: "Ask {bot} for a new link if you still need to sign in.",
    endedRestarted: "Pots restarted",
    endedRestartedText: "The sign-in that ran was lost. {bot} knows, and can send you a new link.",
    notFound: "This link does not work",
    notFoundText: "It may have ended, or been taken back.",
  },
  zh: {
    title: "为 {bot} 登录模型",
    asks: "{bot} 请你登录一个模型",
    asksProvider: "{bot} 请你登录 {provider}",
    linkUntil: "链接 {time} 后失效",
    afterStart: "开始后有 {n} 分钟",
    whatTitle: "这个链接能做什么",
    what: "用你的订阅或 API key，让 {bot} 的电脑登录一个模型服务商，这台电脑上的每个 bot 和 pi 程序都会用这个登录。新登录会替换这台电脑上该服务商原来的登录。按「开始」前什么都不会发生；只有第一个按「开始」的设备能用。{bot} 只会知道你登录了哪个服务商、能用哪些模型，不会知道你的 key、验证码或账号。",
    tunnel: "这个页面经过 Cloudflare 的免费通道，Cloudflare 能看到这里显示和输入的内容。设备码是安全的。在这里粘贴的代码或地址、输入的 API key，Cloudflare 能用来完成登录或使用这个 key。",
    start: "开始",
    continue: "继续",
    elsewhere: "这个链接已经在另一台设备上打开了。只有第一个按「开始」的设备能用。",
    network: "连不上 {bot}，检查网络后再试。",
    noscript: "这个页面需要 JavaScript。",
    subscription: "订阅",
    subscriptionNote: "ChatGPT、Claude、GitHub Copilot、Grok、Kimi 等",
    apiKey: "API key",
    apiKeyNote: "任何服务商，也包括 Jev 判断用的 TypeSafe",
    search: "搜索服务商",
    noMatch: "没有匹配的服务商。",
    there: "现在已登录",
    replaceTitle: "替换 {provider} 的登录？",
    replaceText: "{bot} 的电脑现在有 {provider} 的登录。登录后会替换它，这台电脑上的每个 bot 和 pi 程序都会用新的登录。",
    replaceGo: "登录并替换",
    back: "返回",
    signingIn: "正在登录 {provider}",
    cancel: "取消",
    openSignIn: "打开登录页面",
    deviceCode: "在 {host} 输入这个码",
    copy: "复制",
    copied: "已复制",
    openSite: "打开 {host}",
    codeUntil: "这个码 {time} 前有效",
    pasteHint: "登录后，服务商会显示一个码，或者浏览器停在一个打不开的页面（地址以 http://localhost 或 http://127.0.0.1 开头）。复制那个码，或那个页面的完整地址，粘贴到这里。",
    recommended: "在这台设备上能用",
    hidden: "这里不提供以下方式，它们要在那台电脑上设置：{ways}。{bot} 可以在它的电脑上设置，在聊天里问它。",
    secretWarn: "和密码页一样，Cloudflare 能看到你在这里输入的内容。想要私密连接，先请 {bot} 设置 Tailscale Funnel。",
    codeWarn: "Cloudflare 能看到你在这里粘贴的内容和上面的登录链接，这可能足以用你的名义完成这次登录。想要私密连接，先请 {bot} 设置 Tailscale Funnel。",
    send: "继续",
    empty: "不能为空。",
    gone: "pi 已经往下走了，这是它现在的状态。",
    signedIn: "已登录 {provider}",
    replaced: "已替换原来的登录。",
    ready: "可以用：{model}",
    notAnswer: "{model} 没有回应：{reason}",
    judgeReady: "可以当判断模型：{model}",
    noModels: "pi 没有列出这个登录能用的模型。",
    failed: "没有登录 {provider}",
    cancelled: "已取消。",
    another: "再登录一个",
    tryAgain: "再试一次",
    done: "完成",
    doneNote: "每次登录 {bot} 都会知道。全部做完后按「完成」。",
    working: "正在处理…",
    oneMinute: "还剩 1 分钟",
    endedDone: "都好了",
    endedDoneText: "可以关掉这个页面了。{bot} 知道你登录了什么。",
    endedExpired: "这个链接已失效",
    endedExpiredText: "还需要登录的话，请 {bot} 再发一个链接。",
    endedRevoked: "{bot} 收回了这个链接",
    endedRevokedText: "还需要登录的话，请 {bot} 再发一个链接。",
    endedRestarted: "Pots 重启了",
    endedRestartedText: "正在进行的登录丢失了。{bot} 已经知道，可以再给你发一个链接。",
    notFound: "这个链接不能用",
    notFoundText: "它可能已经失效，或者被收回了。",
  },
} as const;

export type LoginWords = Record<keyof (typeof WORDS)["en"], string>;

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

/** What the page's script needs, as JSON in the page. */
export interface LoginFacts {
  bot: string;
  lang: Lang;
  /** The provider the bot made the link for, or null. */
  provider: string | null;
  quickTunnel: boolean;
  minutes: number;
  words: LoginWords;
}

/** The kit's folder, relative to a login link's page (/g/<token>/), which keeps any path a proxy puts in front. */
const KIT = "../../__pots/kit/login/";

function page(lang: Lang, title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<link rel="stylesheet" href="${KIT}login.css">
${head}</head>
<body>
${body}
</body>
</html>
`;
}

/** The page of a link that is open or started: the start screen, and the script that does the rest. */
export function renderLoginPage(view: LoginView, botName: string, options: { lang: Lang; quickTunnel: boolean; minutes: number; providerName?: string }): string {
  const words = Object.fromEntries(Object.entries(WORDS[options.lang]).map(([key, text]) => [key, fill(text, { bot: botName, bots: possessive(botName) })])) as LoginWords;
  const facts: LoginFacts = { bot: botName, lang: options.lang, provider: view.provider, quickTunnel: options.quickTunnel, minutes: options.minutes, words };
  // JSON in a script element that does not run: "<" is escaped so the text cannot end the element.
  const json = JSON.stringify(facts).replace(/</g, "\\u003c");
  const initial = escape(botName.trim().charAt(0).toUpperCase() || "P");
  const asks = view.provider ? fill(words.asksProvider, { provider: options.providerName ?? view.provider }) : words.asks;
  return page(
    options.lang,
    words.title,
    `<script type="application/json" id="pots-facts">${json}</script>
<main id="start" class="page">
  <div class="who"><span class="ava" aria-hidden="true">${initial}</span><span>${escape(asks)}</span></div>
  ${view.text ? `<div class="ask words${isLongText(view.text) ? " long" : ""}">${textHtml(view.text)}</div>` : ""}
  <div class="meta" id="start-meta"></div>
  <details class="fold"><summary>${escape(words.whatTitle)}</summary><p>${escape(words.what)}${options.quickTunnel ? ` ${escape(words.tunnel)}` : ""}</p></details>
  <noscript><p class="msg">${escape(words.noscript)}</p></noscript>
  <div class="go">
    <p class="msg" id="start-msg" role="alert"></p>
    <button type="button" class="big" id="start-button" disabled>${escape(words.start)}</button>
  </div>
</main>
<main id="session" class="page" hidden></main>`,
    `<script type="module" src="${KIT}login.js"></script>\n`,
  );
}

/** The page of a link that ended, or of none. */
export function renderLoginEnded(state: "done" | "expired" | "revoked" | "restarted" | "missing", botName: string, lang: Lang): string {
  const words = WORDS[lang];
  const [title, text] =
    state === "done"
      ? [words.endedDone, words.endedDoneText]
      : state === "expired"
        ? [words.endedExpired, words.endedExpiredText]
        : state === "revoked"
          ? [words.endedRevoked, words.endedRevokedText]
          : state === "restarted"
            ? [words.endedRestarted, words.endedRestartedText]
            : [words.notFound, words.notFoundText];
  const values = { bot: botName || "the bot" };
  return page(
    lang,
    fill(title, values),
    `<main class="page ended"><div class="check ${state === "done" ? "good" : "gone"}" aria-hidden="true"></div><h1>${escape(fill(title, values))}</h1><p class="meta">${escape(fill(text, values))}</p></main>`,
  );
}
