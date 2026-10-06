// Pins what format-tiers reads as a number or a date formatted by hand: the platform's own formatters and the base
// library's English labels, and neither once a comment quotes them or the site says why it must stay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCalls } from "./lib/format-calls.mjs";

const lines = (text) => formatCalls(text).map(({ line }) => line);

test("the browser's formatters are judged, each on its own line", () => {
    assert.deepEqual(lines("const a = count.toLocaleString();\nconst b = at.toLocaleDateString(`en`);\nconst c = at.toLocaleTimeString();"), [1, 2, 3]);
    assert.deepEqual(lines("const f = new Intl.NumberFormat(locale);\nconst g = new Intl.DateTimeFormat(`en-US`, { hour: `2-digit` });"), [1, 2]);
    assert.deepEqual(lines("const r = new Intl.RelativeTimeFormat(locale, { style: `narrow` });"), [1]);
    assert.match(formatCalls("x.toLocaleString()")[0].why, /toLocaleString\(\) reads the browser's language/);
});

test("a placeholder named like the method, a different method, or a comment quoting it is not a call", () => {
    assert.deepEqual(lines("t(`terminal.lines`, { toLocaleString: formatCount(lines) });"), []);
    assert.deepEqual(lines("const up = word.toLocaleUpperCase(`pl`);"), []);
    assert.deepEqual(lines("// never value.toLocaleString(): it reads the browser's language\n * new Intl.NumberFormat(locale)"), []);
});

test("the base library's English labels are judged where they are imported, a single or a multi-line import", () => {
    assert.deepEqual(lines('import { sizeLabel } from "@intentic/base/format";'), [1]);
    assert.deepEqual(lines('import {\n    clamp,\n    briefDuration,\n    sizeLabel as size,\n} from "@intentic/base";'), [3, 4]);
    assert.deepEqual(lines('import { clamp, plural } from "@intentic/base/format";\nimport { sizeLabel } from "./mine";'), []);
});

test("a site that says why is excused, on its line or in the comment block above it, and only with a reason", () => {
    assert.deepEqual(lines("const day = new Intl.DateTimeFormat(`en-CA`).format(at); // allow(format-tiers): a machine date for an API"), []);
    assert.deepEqual(lines("// The calendar date in a zone.\n// allow(format-tiers): a machine date for an API\nconst day = new Intl.DateTimeFormat(`en-CA`).format(at);"), []);
    assert.deepEqual(lines("// allow(format-tiers):\nconst day = new Intl.DateTimeFormat(`en-CA`).format(at);"), [2]);
});
