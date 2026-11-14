import type { DesktopView } from "./desktop.ts";

// The desktop page: Pots' own HTML, never the bot's. The page is a shell: kit/desktop/desktop.js draws the person's view
// of the desktop with noVNC (kit/desktop/novnc.js), and talks to Pots under the link's path (state, start, end, ws).
// What the bot wrote shows only as text. The page's words come from here, in the person's language when Pots has it.

export type Lang = "en" | "zh";

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** The person's language: the first of the browser's languages that Pots has words for, else English. */
export function pickLang(acceptLanguage: string | undefined): Lang {
  const ranges = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().toLowerCase().split(";");
      const q = Number(params.find((param) => param.trim().startsWith("q="))?.trim().slice(2) ?? 1);
      return { tag: tag ?? "", q: Number.isFinite(q) ? q : 0 };
    })
    .filter((range) => range.tag && range.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranges) {
    if (tag === "zh" || tag.startsWith("zh-")) return "zh";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}

/** The page's words. {bot}, {time}, {n} and the like are filled in where they are used. */
const WORDS = {
  en: {
    title: "{bot}'s desktop",
    asks: "{bot} needs you for one step",
    linkUntil: "The link works until {time}",
    afterStart: "{n} minutes after Start",
    whatTitle: "What this link can do",
    what: "It controls the whole desktop of {bot}'s computer, with every site signed in there. Nothing shows before you press Start, and only the first device that presses Start can use the link.",
    tunnel: "The picture goes through Cloudflare's free tunnel: Cloudflare can see the screen and what you type.",
    start: "Start",
    continue: "Continue",
    fineResize: "When you start, {bot}'s desktop takes the shape of your screen if it can, and goes back when you hand it back.",
    fineWhole: "When you start, you see {bot}'s whole desktop.",
    elsewhere: "This link is open on another device. Only the device that pressed Start first can use it.",
    busy: "Someone is using this desktop through another link right now. Try again when they are done.",
    unreachable: "Pots could not reach {bot}'s desktop, and has told {bot}. Try again in a moment.",
    network: "No connection to {bot}. Check your network and try again.",
    noscript: "This page needs JavaScript.",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    task: "What to do",
    fold: "Fold",
    hintMeta: "The link ends at {time} · only this device can use it",
    zoom: "Zoomed in {n}× · tap for the whole screen",
    gestures: "Tap = click · drag with two fingers = scroll · pinch = zoom",
    keyboard: "Keyboard",
    more: "More",
    done: "Done",
    typeInto: "To {bot}:",
    hideTyped: "Hide what I type",
    enter: "Enter",
    closeKeyboard: "Close the keyboard",
    upright: "Typing is easier with the phone upright.",
    hintPassword: "Tap the password field on the screen, then the keyboard button.",
    hintCode: "Tap the code field on the screen, then the keyboard button.",
    hintText: "Tap the field on the screen, then the keyboard button.",
    esc: "Esc",
    tab: "Tab",
    backspace: "Delete",
    selectAll: "Select all",
    paste: "Paste",
    reconnect: "Reconnect",
    trackpad: "Trackpad",
    trackpadNote: "A finger moves the mouse, for small targets",
    picture: "Picture",
    fitPhone: "Fit phone",
    fitWindow: "Fit window",
    whole: "Whole",
    actual: "1:1",
    cannotRow: "I can't do it, hand back",
    handBackTitle: "Hand back to {bot}?",
    handBackNote: "{bot} will check this step with a screenshot, then carry on.",
    notePlaceholder: "Anything for {bot}? (optional) For example: the code went to my email",
    handBackDone: "✓ Done, hand back",
    handBackCannot: "I can't do it, hand back ({bot} will try another way)",
    keepGoing: "Keep going",
    fullscreen: "Full screen",
    typeClipboard: "Type my clipboard",
    keys: "Send keys",
    keysHintMac: "The keyboard types straight in · ⌘C and ⌘V become Ctrl+C and Ctrl+V · ⌘⇧V types your clipboard",
    keysHint: "The keyboard types straight in",
    oneMinute: "1 minute left",
    noResize: "This desktop keeps its own size. Pinch to zoom in and out.",
    clipboardEmpty: "The clipboard is empty.",
    clipboardDenied: "The browser did not let the page read the clipboard.",
    typed: "Typed {n} characters",
    failed: "Could not do that: {reason}",
    endedDone: "Handed back to {bot}",
    endedDoneText: "You can close this page. {bot} will tell you in the chat how it went.",
    endedCannot: "Handed back to {bot}",
    endedCannotText: "{bot} knows you could not do this step, and will try another way. You can close this page.",
    restored: "The desktop has its own size again.",
    endedExpired: "This link has ended",
    endedExpiredText: "Ask {bot} for a new link if you still need the desktop.",
    endedRevoked: "{bot} took this link back",
    endedRevokedText: "Ask {bot} for a new link if you still need the desktop.",
    notFound: "This link does not work",
    notFoundText: "It may have ended, or been taken back.",
  },
  zh: {
    title: "{bot} 的桌面",
    asks: "{bot} 需要你帮一步",
    linkUntil: "链接 {time} 后失效",
    afterStart: "开始后有 {n} 分钟",
    whatTitle: "这个链接能做什么",
    what: "能操作 {bot} 电脑的整个桌面，包括上面已登录的网站。按「开始」前不显示任何画面；只有第一个按「开始」的设备能用。",
    tunnel: "画面经过 Cloudflare 的免费通道，Cloudflare 能看到画面和你打的字。",
    start: "开始",
    continue: "继续",
    fineResize: "开始后，{bot} 的桌面会尽量改成你屏幕的形状，交还时改回来",
    fineWhole: "开始后会显示 {bot} 的整个桌面",
    elsewhere: "这个链接已经在另一台设备上打开了。只有第一个按「开始」的设备能用。",
    busy: "现在有人在用另一个链接操作这台桌面，等他们用完再试。",
    unreachable: "Pots 连不上 {bot} 的桌面，已经告诉 {bot} 了。稍后再试。",
    network: "连不上 {bot}，检查网络后再试。",
    noscript: "这个页面需要 JavaScript。",
    connecting: "正在连接…",
    reconnecting: "正在重连…",
    task: "要做什么",
    fold: "收起",
    hintMeta: "链接 {time} 后失效 · 只有这台设备能用",
    zoom: "已放大 {n}× · 点一下看整屏",
    gestures: "点 = 点击 · 双指拖 = 滚动 · 双指捏 = 放大",
    keyboard: "键盘",
    more: "更多",
    done: "完成",
    typeInto: "打进 {bot}：",
    hideTyped: "遮住我打的字",
    enter: "回车",
    closeKeyboard: "收起键盘",
    upright: "竖着拿更好打字",
    hintPassword: "先点画面里的密码框，再点键盘按钮。",
    hintCode: "先点画面里的验证码框，再点键盘按钮。",
    hintText: "先点画面里的输入框，再点键盘按钮。",
    esc: "Esc",
    tab: "Tab",
    backspace: "删除",
    selectAll: "全选",
    paste: "粘贴",
    reconnect: "重连",
    trackpad: "触控板模式",
    trackpadNote: "手指滑动移动鼠标，适合点很小的东西",
    picture: "画面",
    fitPhone: "匹配手机",
    fitWindow: "匹配窗口",
    whole: "整屏",
    actual: "1:1",
    cannotRow: "我做不了，交还",
    handBackTitle: "交还给 {bot}？",
    handBackNote: "{bot} 会截图检查这一步，然后接着做。",
    notePlaceholder: "想告诉 {bot} 的话（可不填），比如「验证码发到了我邮箱」",
    handBackDone: "✓ 做完了，交还",
    handBackCannot: "做不了，交还（{bot} 会换别的办法）",
    keepGoing: "再看看",
    fullscreen: "全屏",
    typeClipboard: "把我的剪贴板打进去",
    keys: "发送组合键",
    keysHintMac: "键盘直接打进去 · ⌘C / ⌘V 自动换成 Ctrl+C / Ctrl+V · ⌘⇧V 打出你的剪贴板",
    keysHint: "键盘直接打进去",
    oneMinute: "还剩 1 分钟",
    noResize: "这台桌面不能改大小。双指捏合可以放大缩小。",
    clipboardEmpty: "剪贴板是空的。",
    clipboardDenied: "浏览器不让这个页面读剪贴板。",
    typed: "已打 {n} 个字",
    failed: "没做成：{reason}",
    endedDone: "已交还给 {bot}",
    endedDoneText: "可以关掉这个页面了。{bot} 会在聊天里告诉你结果。",
    endedCannot: "已交还给 {bot}",
    endedCannotText: "{bot} 知道你做不了这一步，会换别的办法。可以关掉这个页面了。",
    restored: "桌面已改回原来的大小。",
    endedExpired: "这个链接已失效",
    endedExpiredText: "还需要的话，请 {bot} 再发一个链接。",
    endedRevoked: "{bot} 收回了这个链接",
    endedRevokedText: "还需要的话，请 {bot} 再发一个链接。",
    notFound: "这个链接不能用",
    notFoundText: "它可能已经失效，或者被收回了。",
  },
} as const;

export type Words = Record<keyof (typeof WORDS)["en"], string>;

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

/**
 * The headers of the desktop page and its answers: its scripts and styles come from this address only, it talks only
 * to this address (also by WebSocket, which some browsers do not count as 'self'), no page can frame it, and no other
 * window keeps a handle on it.
 */
export function desktopHeaders(hosts: readonly (string | undefined)[]): Record<string, string> {
  const socket = [...new Set(hosts.filter((host): host is string => !!host && /^[A-Za-z0-9.:[\]-]+$/.test(host)))].map((host) => ` wss://${host} ws://${host}`).join("");
  return {
    "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'${socket}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
  };
}

/** What the page's script needs, as JSON in the page. */
export interface DesktopFacts {
  bot: string;
  lang: Lang;
  text: string;
  input: string | null;
  area: readonly number[] | null;
  minutes: number;
  /** process.platform of the computer whose desktop it is. */
  remote: string;
  words: Omit<Words, "tunnel">;
}

/** A line that starts with a number or a bullet, such as "1.", "2)", "(3)", "①" or "- ": the mark, and the rest. */
const STEP = /^\s*(\d{1,2}[.)、）:：](?!\d)|[(（]\d{1,2}[)）]|[\u2460-\u2473\u2776-\u2793]|[-*•·–](?=\s))\s*(\S.*)$/;

/**
 * The bot's text as HTML, for the start screen and the page's panel: a paragraph per line as the bot wrote it, and a
 * line that starts with a number or a bullet hangs under its mark, so steps read as a list.
 */
export function textHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => {
      const step = STEP.exec(line);
      if (step) return `<p class="step"><span class="n">${escape(step[1]!)}</span><span>${escape(step[2]!)}</span></p>`;
      return line.trim() ? `<p>${escape(line.trimEnd())}</p>` : `<p class="gap"></p>`;
    })
    .join("");
}

/** Text of more than one line, or longer than about two lines of a phone, reads better in the regular weight. */
export function isLongText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes("\n")) return true;
  let width = 0;
  // A Chinese, Japanese or Korean character is about as wide as two Latin letters.
  for (const char of trimmed) width += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(char) ? 2 : 1;
  return width > 90;
}

/** The kit's folder, relative to a desktop link's page (/d/<token>/), which keeps any path a proxy puts in front. */
const KIT = "../../__pots/kit/desktop/";

function page(lang: Lang, title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=overlays-content">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<link rel="stylesheet" href="${KIT}desktop.css">
${head}</head>
<body>
${body}
</body>
</html>
`;
}

/** The page of a link that is open or started: the start screen, and the script that does the rest. */
export function renderDesktopPage(view: DesktopView, botName: string, options: { lang: Lang; quickTunnel: boolean; remote: string }): string {
  const words = Object.fromEntries(Object.entries(WORDS[options.lang]).map(([key, text]) => [key, fill(text, { bot: botName })])) as Words;
  // The page says it only when it is so; the script has no use for it.
  const { tunnel, ...scriptWords } = words;
  const facts: DesktopFacts = {
    bot: botName,
    lang: options.lang,
    text: view.text,
    input: view.input,
    area: view.area,
    minutes: view.minutes,
    remote: options.remote,
    words: scriptWords,
  };
  // JSON in a script element that does not run: "<" is escaped so the text cannot end the element.
  const json = JSON.stringify(facts).replace(/</g, "\\u003c");
  const initial = escape(botName.trim().charAt(0).toUpperCase() || "P");
  return page(
    options.lang,
    words.title,
    `<script type="application/json" id="pots-facts">${json}</script>
<main id="start" class="page">
  <div class="who"><span class="ava" aria-hidden="true">${initial}</span><span>${escape(words.asks)}</span></div>
  <div class="ask words${isLongText(view.text) ? " long" : ""}" id="ask">${textHtml(view.text)}</div>
  <div class="meta" id="start-meta"></div>
  <details class="fold"><summary>${escape(words.whatTitle)}</summary><p>${escape(words.what)}${options.quickTunnel ? ` ${escape(tunnel)}` : ""}</p></details>
  <noscript><p class="msg">${escape(words.noscript)}</p></noscript>
  <div class="go">
    <p class="msg" id="start-msg" role="alert"></p>
    <button type="button" class="big" id="start-button" disabled>${escape(words.start)}</button>
    <p class="fine">${escape(view.resizable ? words.fineResize : words.fineWhole)}</p>
  </div>
</main>`,
    `<link rel="modulepreload" href="${KIT}novnc.js">\n<script type="module" src="${KIT}desktop.js"></script>\n`,
  );
}

/** The page of a link that ended, or of none. */
export function renderDesktopEnded(state: "done" | "cannot" | "expired" | "revoked" | "missing", botName: string, lang: Lang): string {
  const words = WORDS[lang];
  const [title, text] =
    state === "done"
      ? [words.endedDone, words.endedDoneText]
      : state === "cannot"
        ? [words.endedCannot, words.endedCannotText]
        : state === "expired"
          ? [words.endedExpired, words.endedExpiredText]
          : state === "revoked"
            ? [words.endedRevoked, words.endedRevokedText]
            : [words.notFound, words.notFoundText];
  const values = { bot: botName || "the bot" };
  return page(
    lang,
    fill(title, values),
    `<main class="page ended"><div class="check ${state === "done" || state === "cannot" ? "good" : "gone"}" aria-hidden="true"></div><h1>${escape(fill(title, values))}</h1><p class="meta">${escape(fill(text, values))}</p></main>`,
  );
}
