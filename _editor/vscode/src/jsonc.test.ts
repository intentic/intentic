import { expect, test } from "vitest";
import { jsoncParse } from "./jsonc.js";

test("comments and trailing commas parse away; strings keep their slashes", () => {
    const parsed = jsoncParse(`{
        // the editor's own themes carry comments
        "colors": {
            "editor.background": "#101014", /* and block comments */
        },
        "url": "https://example.com//path",
    }`);
    expect(parsed).toEqual({ colors: { "editor.background": "#101014" }, url: "https://example.com//path" });
});

test("an escaped quote before a comment does not derail the string state", () => {
    expect(jsoncParse(`{ "a": "say \\"hi\\" // not a comment", "b": 1 }`)).toEqual({ a: `say "hi" // not a comment`, b: 1 });
});
