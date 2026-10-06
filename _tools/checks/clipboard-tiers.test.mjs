// Pins what clipboard-tiers reads as reaching the clipboard directly: `navigator.clipboard` in any spelling, and never
// once a comment quotes it or the site says why it must stay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clipboardCalls } from "./lib/clipboard-calls.mjs";

const lines = (text) => clipboardCalls(text).map(({ line }) => line);

test("the browser's clipboard is judged however it is reached", () => {
    assert.deepEqual(
        lines("await navigator.clipboard.writeText(text);\nvoid navigator.clipboard?.readText();\nawait navigator?.clipboard.writeText(text);\nview.navigator.clipboard.writeText(text);"),
        [1, 2, 3, 4],
    );
    assert.match(clipboardCalls("navigator.clipboard.writeText(x)")[0].why, /popped-out window/);
});

test("the kit's door, a paste event's own data, a store named clipboard and a comment quoting the shape are not reaches", () => {
    assert.deepEqual(lines("await writeClipboard(text, event.target);\nclipboardOf(element).writeText(text);"), []);
    assert.deepEqual(lines("const text = event.clipboardData?.getData(`text/plain`);\nstore.clipboard.value = undefined;"), []);
    assert.deepEqual(lines("// never navigator.clipboard: a popped-out window's press does not focus it\n * navigator.clipboard"), []);
});

test("a site that says why is excused, on its line or in the comment block above it, and only with a reason", () => {
    assert.deepEqual(lines("void navigator.clipboard.writeText(x); // allow(clipboard-tiers): the kit's own fallback"), []);
    assert.deepEqual(lines("// allow(clipboard-tiers): the kit's own fallback\nvoid navigator.clipboard.writeText(x);"), []);
    assert.deepEqual(lines("// allow(clipboard-tiers):\nvoid navigator.clipboard.writeText(x);"), [2]);
});
