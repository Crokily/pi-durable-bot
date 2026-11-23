import { parseMarkdown } from "chat";

/**
 * Bare URLs that a chat app would not link right, made explicit Markdown links. GitHub-flavoured Markdown, which
 * Slack, Teams and the Chat SDK converters follow, links a bare URL only after a space or the start of a line, and
 * a link runs to the next space. So in "这页好了：https://example.com/a，看看" the URL is not linked (it follows "："),
 * or is linked with "，看看" in it. This writes such a URL as [https://example.com/a](https://example.com/a). A URL
 * ends at a space, at < or >, or at CJK text and punctuation; trailing . , : ; ! ? ' " * _ ~ and an unmatched ) stay
 * text, as in GFM. URLs in code, in links and in HTML are left alone, and so is a URL apps already link right.
 *
 * after: only a URL that text follows. For Discord, which links a URL after any text but runs it into the text after.
 */
export function linkBareUrls(markdown: string, which: "touching" | "after" = "touching"): string {
  if (!/https?:\/\//i.test(markdown)) return markdown;
  const ranges: [number, number][] = [];
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) ranges.push([start, end]);
    // A link GFM found in bare text: its URL may have run into the text after it.
    else if (node.type === "link" && start !== undefined && end !== undefined && /^https?:\/\//i.test(markdown.slice(start, end))) ranges.push([start, end]);
    else if (node.type !== "link" && node.type !== "linkReference" && node.type !== "image" && node.type !== "imageReference") node.children?.forEach(visit);
  };
  visit(parseMarkdown(markdown) as MarkdownNode);
  let out = "";
  let from = 0;
  for (const [start, end] of ranges) {
    out += markdown.slice(from, start) + linkIn(markdown, start, end, which);
    from = end;
  }
  return out + markdown.slice(from);
}

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/** CJK letters and punctuation, full-width forms, and general punctuation such as “ ” and …: a URL ends there. */
const STOP = "\\s<>\\u2000-\\u206f\\u2e80-\\u9fff\\ua960-\\ua97f\\uac00-\\ud7ff\\uf900-\\ufaff\\ufe10-\\ufe6f\\uff00-\\uffef\\u{20000}-\\u{3ffff}";
const URL = new RegExp(`https?:\\/\\/[^${STOP}]+`, "giu");
const STOPS = new RegExp(`^[${STOP}]`, "u");

/** One text range of the Markdown, with its bare URLs made links where needed. */
function linkIn(markdown: string, start: number, end: number, which: "touching" | "after"): string {
  const text = markdown.slice(start, end);
  return text.replace(URL, (found: string, at: number) => {
    const url = trimmed(found);
    const before = markdown[start + at - 1] ?? "";
    const next = String.fromCodePoint(markdown.codePointAt(start + at + found.length) ?? 32);
    // Part of a longer word or scheme, such as git+https://: not a URL of its own.
    if (/[A-Za-z0-9+.-]/.test(before)) return found;
    const cut = STOPS.test(next) && !/\s/.test(next);
    const blocked = before !== "" && !/[\s(*_~]/.test(before);
    if (!(cut || (which === "touching" && blocked)) || !/^https?:\/\/[^/?#]/i.test(url)) return found;
    return `[${url.replace(/[\\[\]`]/g, "\\$&")}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})${found.slice(url.length)}`;
  });
}

/** The URL without the punctuation GFM leaves after it: . , : ; ! ? ' " * _ ~ and a ) that closes nothing in it. */
function trimmed(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1]!;
    if (/[.,:;!?'"*_~]/.test(last)) end--;
    else if (last === ")" && count(url.slice(0, end), "(") < count(url.slice(0, end), ")")) end--;
    else return url.slice(0, end);
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}
