import { escapeHtml, escapeRegExp, isRecord } from "./escape.js";

test("escapeHtml replaces all five HTML-active characters, the apostrophe included", () => {
    expect(escapeHtml(`<a href='x'>&"`)).toBe("&lt;a href=&#39;x&#39;&gt;&amp;&quot;");
});

test("escapeRegExp makes every syntax character match only itself", () => {
    const special = ".*+?^$" + "{}()|[]\\/";
    expect(new RegExp(`^${escapeRegExp(special)}$`).test(special)).toBe(true);
    expect(escapeRegExp("a.b")).toBe(String.raw`a\.b`);
});

test("isRecord is a plain object, never null or an array", () => {
    expect([isRecord({}), isRecord({ a: 1 }), isRecord(null), isRecord([]), isRecord("x"), isRecord(undefined)]).toEqual([true, true, false, false, false, false]);
});
