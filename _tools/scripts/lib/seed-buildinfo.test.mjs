// Pins which sibling build info a fresh checkout starts its web check from: never its own (seen under another name), only
// one that recorded a clean check, the newest first.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkedClean, siblings } from "./seed-buildinfo.mjs";

const TARGET = join("web", ".cache", "tsbuildinfo");

// A worktree holding a build info written `ageSeconds` ago.
const tree = (root, name, ageSeconds) => {
    const path = join(root, name);
    mkdirSync(join(path, "web", ".cache"), { recursive: true });
    writeFileSync(join(path, TARGET), "{}");
    const at = Date.now() / 1000 - ageSeconds;
    utimesSync(join(path, TARGET), at, at);
    return path;
};

test("the candidates are the other worktrees' build infos, newest first, never this checkout's own", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-buildinfo-"));
    const old = tree(root, "old", 600);
    const fresh = tree(root, "fresh", 10);
    const self = tree(root, "self", 1);
    const bare = join(root, "bare");
    mkdirSync(bare);
    const found = siblings(
        TARGET,
        [old, fresh, self, bare].map((path) => ({ path, head: "abc" })),
        self,
    );
    assert.deepEqual(
        found.map(({ path }) => path),
        [join(fresh, TARGET), join(old, TARGET)],
    );
});

test("only a build info whose check found nothing is a start worth taking", () => {
    assert.equal(checkedClean(JSON.stringify({ semanticDiagnosticsPerFile: [], version: "6.0.3" })), true);
    assert.equal(checkedClean(JSON.stringify({ semanticDiagnosticsPerFile: [[252, [{ code: 7016 }]]] })), false);
    assert.equal(checkedClean(JSON.stringify({ program: { semanticDiagnosticsPerFile: [] } })), true);
    assert.throws(() => checkedClean('{"semanticDiagnosticsPerFile": ['));
});
