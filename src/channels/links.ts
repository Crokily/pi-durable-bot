import { parseMarkdown } from "chat";

/**
 * A space between a bare URL and CJK text that touches it, so that a chat app links the URL and ends the link where the
 * URL ends. GitHub-flavoured Markdown, which Slack, Teams and the Chat SDK converters follow, links a bare URL only after
 * a space, the start of a line or one of * _ ~ (, and a link runs to the next space. So in "这页：https://example.com/a，看看"
 * the URL is not linked (it follows "："), or is linked with "，看看" in it; this makes it "这页： https://example.com/a ，看看".
 *
 * Only a space is added: the URL itself is never changed, so a link never goes anywhere it would not have gone. A space
 * goes after a URL only at CJK or full-width punctuation, or at general punctuation such as ” and …, which a URL does not
 * hold. At CJK letters it is left alone, as they may be part of the URL (https://ja.wikipedia.org/wiki/東京). URLs in
 * code, in links and images, in HTML and in the paragraph around inline HTML, and in <...> (Slack's <url|label>,
 * addresses) are left alone.
 *
 * after: only a space after a URL. For Discord, which links a URL after any text but runs it into the text after.
 */
export function separateBareUrls(markdown: string, which: "both" | "after" = "both"): string {
  if (!/https?:\/\//i.test(markdown)) return markdown;
  const kept = keptRanges(markdown);
  return markdown.replace(URL, (url: string, at: number) => {
    const end = at + url.length;
    if (kept.some(([from, to]) => from < end && at < to)) return url;
    if (!/^https?:\/\/[^/?#\\]/i.test(url)) return url;
    const before = lastChar(markdown.slice(0, at));
    // Part of a longer word or scheme, such as git+https://: not a URL of its own.
    if (/[\p{L}\p{N}+.-]/u.test(before) && !CJK.test(before)) return url;
    const next = String.fromCodePoint(markdown.codePointAt(end) ?? 32);
    const space = which === "both" && CJK.test(before) ? " " : "";
    return space + url + (ENDS.test(next) ? " " : "");
  });
}

/** Punctuation a URL does not hold: general punctuation such as “ ” … —, CJK punctuation, and full-width punctuation. */
const PUNCTUATION = "\\u2000-\\u206f\\u3000-\\u303f\\ufe10-\\ufe1f\\ufe30-\\ufe6f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65";
/** CJK letters, kana, hangul and full-width forms. */
const LETTERS = "\\u2e80-\\u2fff\\u3040-\\u9fff\\ua960-\\ua97f\\uac00-\\ud7ff\\uf900-\\ufaff\\uff00-\\uffef\\u{20000}-\\u{3ffff}";
const URL = new RegExp(`https?:\\/\\/[^\\s<>${PUNCTUATION}]+`, "giu");
const ENDS = new RegExp(`^[${PUNCTUATION}]`, "u");
const CJK = new RegExp(`^[${PUNCTUATION}${LETTERS}]$`, "u");

function lastChar(text: string): string {
  return text ? String.fromCodePoint(text.codePointAt(text.length - (/[\udc00-\udfff]$/.test(text) ? 2 : 1))!) : "";
}

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

const KEPT = new Set(["code", "inlineCode", "html", "image", "imageReference", "definition", "math", "inlineMath", "link", "linkReference"]);

/**
 * The source ranges to leave as they are: code, HTML, images, links written as links (not a URL GFM linked in text), a
 * block that holds inline HTML (whose content may be <code> or <a>), and anything in <...> on one line.
 */
function keptRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = [];
  const range = (node: MarkdownNode): [number, number] | undefined => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined ? undefined : [start, end];
  };
  const visit = (node: MarkdownNode) => {
    const at = range(node);
    if (at && KEPT.has(node.type) && !(node.type === "link" && /^https?:\/\//i.test(markdown.slice(...at)))) {
      ranges.push(at);
      return;
    }
    if (at && node.children?.some((child) => child.type === "html")) {
      ranges.push(at);
      return;
    }
    node.children?.forEach(visit);
  };
  visit(parseMarkdown(markdown) as MarkdownNode);
  for (const match of markdown.matchAll(/<[^<>\n]*>/g)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}
