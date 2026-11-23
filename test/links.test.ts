import { describe, expect, it } from "vitest";
import { linkBareUrls } from "../src/channels/links.ts";

const URL = "https://example.com/p/a_b/";
const link = `[${URL}](${URL})`;

describe("linkBareUrls", () => {
  it("makes a URL a link where GFM would not link it, or would run it into the text after it", () => {
    expect(linkBareUrls(`这页好了：${URL}`)).toBe(`这页好了：${link}`);
    expect(linkBareUrls(`链接${URL}。`)).toBe(`链接${link}。`);
    expect(linkBareUrls(`看 ${URL}，好`)).toBe(`看 ${link}，好`);
    expect(linkBareUrls(`（${URL}）`)).toBe(`（${link}）`);
    expect(linkBareUrls(`“${URL}”`)).toBe(`“${link}”`);
    expect(linkBareUrls(`見て${URL}です`)).toBe(`見て${link}です`);
    expect(linkBareUrls(`${URL}.看`)).toBe(`${link}.看`);
    expect(linkBareUrls(`**：${URL}**`)).toBe(`**：${link}**`);
    expect(linkBareUrls("x：https://example.com/a_(b)")).toBe("x：[https://example.com/a_(b)](https://example.com/a_%28b%29)");
  });

  it("leaves a URL apps already link right", () => {
    for (const text of [`看 ${URL} 好`, `see ${URL}.`, `(${URL})`, URL, `- ${URL}\n- next`]) expect(linkBareUrls(text)).toBe(text);
  });

  it("leaves URLs in code, links and HTML, and URLs that are part of a longer word", () => {
    for (const text of [`\`：${URL}\``, "```\n：" + URL + "\n```", `[：${URL}](${URL})`, `<${URL}>`, `![图：${URL}](${URL})`, `git+${URL}`, "：https://", "：https:///x"]) {
      expect(linkBareUrls(text)).toBe(text);
    }
  });

  it("only a URL with text right after it, for Discord", () => {
    expect(linkBareUrls(`这页：${URL}`, "after")).toBe(`这页：${URL}`);
    expect(linkBareUrls(`这页：${URL}，看看`, "after")).toBe(`这页：${link}，看看`);
  });
});
