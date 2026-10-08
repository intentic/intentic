// Pins which sandbox entries CI takes: only for a hash its own dry run gives to an output-less task, only as that task's
// own log, and never over an entry CI already holds. The tasks are shaped as `turbo run --dry=json` prints them.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, test } from "node:test";
import { readTar, writeTar } from "./artifact.mjs";
import { importResults } from "./import.mjs";
import { readEntry, writeEntry } from "./store.mjs";

let root;
let from;
let into;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "turbo-cache-import-"));
    from = join(root, "sandbox");
    into = join(root, "ci");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const task = (taskId, hash, outputs, command = "tsgo --noEmit") => {
    const [pkg, name] = taskId.split("#");
    return { taskId, hash, command, logFile: `packages/${pkg}/.turbo/turbo-${name}.log`, resolvedTaskDefinition: { cache: true, outputs } };
};
const logFor = (pkg, name, text = "ok\n") => zstdCompressSync(writeTar([{ path: `packages/${pkg}/.turbo/turbo-${name}.log`, data: Buffer.from(text) }]));

test("an output-less task's sandbox entry is imported as its own log, with its duration", () => {
    writeEntry(from, "aaaaaaaaaaaaaaaa", logFor("a", "typecheck"), 4200);
    const result = importResults([task("a#typecheck", "aaaaaaaaaaaaaaaa", [])], from, into);
    assert.deepEqual(result.imported, ["a#typecheck"]);
    const entry = readEntry(into, "aaaaaaaaaaaaaaaa");
    assert.equal(entry.durationMs, 4200);
    assert.equal(readTar(zstdDecompressSync(entry.body))[0].path, "packages/a/.turbo/turbo-typecheck.log");
});

test("an entry filed under a build's hash is never read, however harmless it looks", () => {
    writeEntry(from, "bbbbbbbbbbbbbbbb", logFor("a", "build"), 1);
    const result = importResults([task("a#build", "bbbbbbbbbbbbbbbb", ["dist/**"])], from, into);
    assert.equal(result.considered, 0);
    assert.equal(readEntry(into, "bbbbbbbbbbbbbbbb"), undefined);
});

test("an entry holding some other task's log is refused", () => {
    writeEntry(from, "cccccccccccccccc", logFor("b", "typecheck"), 1);
    const result = importResults([task("a#typecheck", "cccccccccccccccc", [])], from, into);
    assert.deepEqual(result.imported, []);
    assert.match(result.refused[0], /only packages\/a\/\.turbo\/turbo-typecheck\.log belongs/);
});

test("what CI already holds stays as CI recorded it, and a task with no script is not considered", () => {
    writeEntry(into, "dddddddddddddddd", logFor("a", "typecheck", "from ci\n"), 1);
    writeEntry(from, "dddddddddddddddd", logFor("a", "typecheck", "from a sandbox\n"), 1);
    writeEntry(from, "eeeeeeeeeeeeeeee", logFor("b", "typecheck"), 1);
    const result = importResults(
        [task("a#typecheck", "dddddddddddddddd", []), task("b#typecheck", "eeeeeeeeeeeeeeee", [], "<NONEXISTENT>")],
        from,
        into,
    );
    assert.equal(result.held, 1);
    assert.equal(result.considered, 1);
    assert.equal(readTar(zstdDecompressSync(readFileSync(join(into, "dddddddddddddddd.tar.zst"))))[0].data.toString(), "from ci\n");
    assert.equal(readEntry(into, "eeeeeeeeeeeeeeee"), undefined);
});
