// Runnable, framework-free check for the tree selection math (the web app has no test runner).
// Run: node _apps/web/scripts/treeSelect.check.mjs  (Node 24 strips the imported .ts types natively.)
import assert from "node:assert/strict";
import { selectRange, stepLead } from "../src/pages/workspace/treeSelect.ts";

const order = ["a", "b/x", "b/y", "c"];

// selectRange: forward, backward (same result), single element, and missing endpoint → just the lead.
assert.deepEqual(selectRange(order, "b/x", "c"), ["b/x", "b/y", "c"]);
assert.deepEqual(selectRange(order, "c", "b/x"), ["b/x", "b/y", "c"]);
assert.deepEqual(selectRange(order, "b/y", "b/y"), ["b/y"]);
assert.deepEqual(selectRange(order, "gone", "c"), ["c"]);

// stepLead: down, up, clamp at both ends, and starting from null.
assert.equal(stepLead(order, "a", 1), "b/x");
assert.equal(stepLead(order, "b/x", -1), "a");
assert.equal(stepLead(order, "a", -1), "a"); // clamp top
assert.equal(stepLead(order, "c", 1), "c"); // clamp bottom
assert.equal(stepLead(order, null, 1), "a"); // first from null
assert.equal(stepLead(order, null, -1), "c"); // last from null
assert.equal(stepLead([], "a", 1), null); // empty tree

console.log("treeSelect.check: OK");
