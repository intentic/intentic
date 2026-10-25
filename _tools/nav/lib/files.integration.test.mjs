import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listFiles } from "./files.mjs";
import { buildTree } from "./tree.mjs";
import { estimateTokens } from "./tokens.mjs";
import { runReplay } from "../replay.mjs";

const root = mkdtempSync(join(tmpdir(), "nav-scope-"));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (path, text) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
};
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
git("init", "-q");
put("package.json", '{"name":"nav-fixture"}');
put("src/policy.ts", "const titleAllowed = () => true;\n");
put("src/policy.test.ts", "titleAllowed();\n");
put("other/unrelated.ts", "export const titleAllowed = () => false;\n");
put(".gitignore", "ignored/\n");
git("add", ".");
git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
put("ignored/noise.ts", "export const titleAllowed = () => false;\n");

test("scoped measurement includes a new unstaged module and excludes a deleted tracked module", () => {
    put("src/added.ts", "export const added = 1;\n");
    rmSync(join(root, "src/policy.test.ts"));
    assert.deepEqual(listFiles(root, undefined, "src/"), { source: ["src/added.ts", "src/policy.ts"], tests: [] });
    put("src/policy.test.ts", "titleAllowed();\n");
});

test("a ref reads its own files and the scope cannot silently select nothing or leave the repository", () => {
    assert.deepEqual(listFiles(root, "HEAD", "src"), { source: ["src/policy.ts"], tests: ["src/policy.test.ts"] });
    assert.throws(() => listFiles(root, undefined, "missing"), /no source or tests/);
    assert.throws(() => listFiles(root, undefined, "../outside"), /outside the repository/);
});

test("session replay finds a private owner inside the scope and reports test noise separately", () => {
    const tree = buildTree(root, undefined, estimateTokens, undefined, "src");
    const [result] = runReplay(tree, estimateTokens, [{ task: "Title policy", symbol: "titleAllowed", guessedPaths: ["src/summary.ts"] }]);
    assert.equal(result.home, "src/policy.ts");
    assert.equal(result.sourceSearchHits, 1);
    assert.equal(result.testSearchHits, 1);
    assert.deepEqual(result.recordedPathMisses, ["src/summary.ts"]);
    assert.throws(() => runReplay(tree, estimateTokens, [{ task: "Unknown", symbol: "absent" }]), /0 definitions/);
});

test("replay refuses ambiguous owners instead of crediting the first definition", () => {
    const tree = buildTree(root, undefined, estimateTokens);
    assert.throws(() => runReplay(tree, estimateTokens, [{ task: "Ambiguous", symbol: "titleAllowed" }]), /2 definitions/);
});
