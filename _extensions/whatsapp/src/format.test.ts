import { toWhatsAppText } from "./format.js";

/* Markdown a model writes out of habit becomes WhatsApp's own marks; what WhatsApp already renders stays as written. */

test("markdown bold, underscores, strikethrough and headings become WhatsApp's single marks", () => {
    expect(toWhatsAppText("**Deploy** is __done__, ~~maybe~~")).toBe("*Deploy* is _done_, ~maybe~");
    expect(toWhatsAppText("## Release **notes**\nall good")).toBe("*Release notes*\nall good");
});

test("a link keeps its label and shows the URL WhatsApp can preview; a bare-URL link is just the URL", () => {
    expect(toWhatsAppText("see [the docs](https://intentic.dev/docs)")).toBe("see the docs (https://intentic.dev/docs)");
    expect(toWhatsAppText("[intentic.dev](https://intentic.dev/)")).toBe("https://intentic.dev/");
    expect(toWhatsAppText("![](https://example.com/a.png)")).toBe("https://example.com/a.png");
});

test("WhatsApp's own single-star bold and code, fenced or inline, pass through untouched", () => {
    expect(toWhatsAppText("*already bold* and _italic_")).toBe("*already bold* and _italic_");
    const code = "run `**not bold**` then\n```\n# not a heading\n**x**\n```\n**after**";
    expect(toWhatsAppText(code)).toBe("run `**not bold**` then\n```\n# not a heading\n**x**\n```\n*after*");
});

test("a lone pair of asterisks or a heading marker inside a sentence is left alone", () => {
    expect(toWhatsAppText("2 ** 3 is 8, issue #12")).toBe("2 ** 3 is 8, issue #12");
});
