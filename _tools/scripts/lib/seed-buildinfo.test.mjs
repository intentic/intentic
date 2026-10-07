// Pins which sibling build info a fresh checkout starts its web check from: never its own (seen under another name), only
// one that recorded a clean check, the newest first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkedClean, sharedPath, siblings } from "./seed-buildinfo.mjs";

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

test("on the fleet a build info lives in the share under the package's path, and nowhere off it", () => {
    assert.equal(sharedPath("/ci-cache/tsbuildinfo", "_editor/web/", ".cache/tsbuildinfo"), "/ci-cache/tsbuildinfo/_editor/web/.cache/tsbuildinfo");
    assert.equal(sharedPath(undefined, "_editor/web/", ".cache/tsbuildinfo"), undefined);
    assert.equal(sharedPath("", "_editor/web/", ".cache/tsbuildinfo"), undefined);
});

// The whole round trip as the web's typecheck script runs it: a passing check saves, and a runner holding an older build
// info of its own starts the next check from the saved one, while a check that found errors is never saved.
test("a passing check's build info is saved to the share, and a runner's older one is replaced by it", () => {
    const repo = mkdtempSync(join(tmpdir(), "seed-share-repo-"));
    const share = mkdtempSync(join(tmpdir(), "seed-share-"));
    execFileSync("git", ["init", "-q", repo]);
    const pkg = join(repo, "web");
    mkdirSync(join(pkg, ".cache"), { recursive: true });
    const local = join(pkg, ".cache", "tsbuildinfo");
    const script = new URL("./seed-buildinfo.mjs", import.meta.url).pathname;
    const run = (...args) =>
        execFileSync(process.execPath, [script, ...args], { cwd: pkg, env: { ...process.env, TSBUILDINFO_SHARE_DIR: share }, stdio: "pipe" });
    const clean = JSON.stringify({ program: { semanticDiagnosticsPerFile: [] }, saved: "fleet" });

    writeFileSync(local, JSON.stringify({ program: { semanticDiagnosticsPerFile: [["a.ts", []]] } }));
    run("--save", ".cache/tsbuildinfo");
    assert.equal(existsSync(join(share, "web", ".cache", "tsbuildinfo")), false, "a check with errors is not saved");

    writeFileSync(local, clean);
    run("--save", ".cache/tsbuildinfo");
    assert.equal(readFileSync(join(share, "web", ".cache", "tsbuildinfo"), "utf8"), clean);

    writeFileSync(local, JSON.stringify({ program: { semanticDiagnosticsPerFile: [] }, saved: "runner" }));
    const old = Date.now() / 1000 - 3600;
    utimesSync(local, old, old);
    run(".cache/tsbuildinfo");
    assert.equal(readFileSync(local, "utf8"), clean);
});
