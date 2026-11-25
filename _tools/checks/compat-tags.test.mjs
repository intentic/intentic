// Pins how a compat tag is read: live above the floor, dead at or below it, an unknown peer, a malformed body, a tag with
// no why, and the things that are not tags at all (a call with no colon after it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { tagFindings } from "./lib/compat-tags.mjs";

const FLOORS = new Map([["daemon", "1.249.0"]]);
const problems = (text) => tagFindings(text, FLOORS).map(({ line, problem }) => `${line} ${problem.split(":")[0]}`);

test("a tag above the floor is live, in every comment shape", () => {
    assert.deepEqual(
        problems(
            [
                "// compat(daemon<1.260.0): an older daemon has no roster rev",
                "/* compat(daemon<1.300.1): no route */",
                "<!-- compat(daemon<2.0.0): no field -->",
                "# compat(daemon<1.250.0): no flag",
            ].join("\n"),
        ),
        [],
    );
});

test("a tag at or below the floor is dead", () => {
    assert.deepEqual(problems("// compat(daemon<1.249.0): x\n// compat(daemon<1.100.0): y"), ["1 dead", "2 dead"]);
});

test("a peer with no floor, a malformed body and a missing why are each findings", () => {
    assert.deepEqual(problems("// compat(phone<1.300.0): x"), ["1 names no peer with a floor (daemon)"]);
    assert.deepEqual(problems("// compat(daemon<1.300): x\n// compat(daemon 1.300.0): y\n// compat(daemon<1.300.0-rc.1): z"), [
        "1 not a tag",
        "2 not a tag",
        "3 not a tag",
    ]);
    assert.deepEqual(problems("// compat(daemon<1.300.0):\n/* compat(daemon<1.300.0): */"), ["1 says no why", "2 says no why"]);
});

test("a call is not a tag", () => {
    assert.deepEqual(problems("let c = Connection::new(io.compat(), config());\nconst x = compat(a<b);"), []);
});
