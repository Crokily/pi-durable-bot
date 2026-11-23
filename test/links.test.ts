import { describe, expect, it } from "vitest";
import { separateBareUrls } from "../src/channels/links.ts";

const URL = "https://example.com/p/a_b/";

describe("separateBareUrls", () => {
  it("sets a URL apart from CJK text that touches it, with a space, and never changes the URL", () => {
    expect(separateBareUrls(`这页好了：${URL}`)).toBe(`这页好了： ${URL}`);
    expect(separateBareUrls(`链接${URL}。`)).toBe(`链接 ${URL} 。`);
    expect(separateBareUrls(`看 ${URL}，好`)).toBe(`看 ${URL} ，好`);
    expect(separateBareUrls(`（${URL}）`)).toBe(`（ ${URL} ）`);
    expect(separateBareUrls(`“${URL}”`)).toBe(`“ ${URL} ”`);
    expect(separateBareUrls(`**：${URL}**`)).toBe(`**： ${URL}**`);
    expect(separateBareUrls("：https://e.org/data(test)，")).toBe("： https://e.org/data(test) ，");
    expect(separateBareUrls("https://e.org/?key=abc_，看")).toBe("https://e.org/?key=abc_ ，看");
    expect(separateBareUrls("：https://e.org?q=*foo*&copy;z")).toBe("： https://e.org?q=*foo*&copy;z");
    expect(separateBareUrls("[文档：https://example.com/doc，查看]")).toBe("[文档： https://example.com/doc ，查看]");
    expect(separateBareUrls("下载!https://a.test/file，点")).toBe("下载!https://a.test/file ，点");
    expect(separateBareUrls("||https://e.org/a||，看")).toBe("||https://e.org/a|| ，看");
  });

  it("keeps Unicode in a URL, and leaves CJK letters after a URL alone: they may be part of it", () => {
    expect(separateBareUrls("看https://en.wikipedia.org/wiki/東京。")).toBe("看 https://en.wikipedia.org/wiki/東京 。");
    expect(separateBareUrls("：https://example.com/search?q=東京")).toBe("： https://example.com/search?q=東京");
    expect(separateBareUrls(`見て${URL}です`)).toBe(`見て ${URL}です`);
  });

  it("leaves a URL apps already link right, and text a space could break", () => {
    for (const text of [`看 ${URL} 好`, `see ${URL}.`, `(${URL})`, URL, `- ${URL}\n- next`, `${URL}.看`]) {
      expect(separateBareUrls(text)).toBe(text);
    }
  });

  it("leaves URLs in code, links, HTML and <...>, and URLs that are part of a longer word", () => {
    for (const text of [
      `\`：${URL}，\``,
      "```\n：" + URL + "，\n```",
      `[：${URL}，](${URL})`,
      `[${URL}](${URL})，`,
      `<${URL}>`,
      `![图：${URL}，](${URL})`,
      `看<code>：${URL}，</code>`,
      `看<a href="${URL}">：${URL}，</a>`,
      `<${URL}|阅读，这里>`,
      `<https://example.com/a|Read this>`,
      `链接：<teams:@alice>`,
      `git+${URL}，`,
      "：https://",
      "：https:///x",
    ]) {
      expect(separateBareUrls(text)).toBe(text);
    }
  });

  it("only after a URL, for Discord", () => {
    expect(separateBareUrls(`这页：${URL}`, "after")).toBe(`这页：${URL}`);
    expect(separateBareUrls(`这页：${URL}，看看`, "after")).toBe(`这页：${URL} ，看看`);
  });
});
