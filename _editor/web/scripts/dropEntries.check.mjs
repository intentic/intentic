// Runnable, framework-free check for the drop-traversal recursion (the web app has no test runner).
// Run: node _editor/web/scripts/dropEntries.check.mjs  (Node 24 strips the imported .ts types natively.)
import assert from "node:assert/strict";
import { collectDroppedFiles, filesToEntries, isRootGitPath } from "../src/pages/workspace/dropEntries.ts";

// Fake FileSystemEntry builders (only the fields the walk touches). fullPath is required: the walk dedupes on it
// to break symlink cycles; the real API always supplies a unique string, so the fakes do too (defaults to name).
const fileEntry = (name, fullPath = `/${name}`) => ({ isFile: true, isDirectory: false, name, fullPath, file: (cb) => cb({ name }) });
const dirEntry = (name, children, fullPath = `/${name}`) => ({
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    // readEntries yields the whole batch once, then []: mirrors the real batched reader the walk drains.
    createReader: () => {
        let drained = false;
        return {
            readEntries: (cb) => {
                if (drained) {
                    cb([]);
                    return;
                }
                drained = true;
                cb(children);
            },
        };
    },
});

// A drop of one or more entry roots (a folder or loose file each). `null` roots model webkitGetAsEntry returning
// nothing (a symlink/special item Chrome won't expose).
const dt = (roots, files = []) => ({ items: roots.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })), files });
// The walk is parallel, so path ORDER isn't deterministic: compare as sorted sets.
const paths = (result) => result.files.map((e) => e.path).sort();

// A nested folder flattens to slash-joined relative paths. Give every entry a distinct fullPath so the visited set
// doesn't collapse same-named nodes.
const tree = dirEntry("root", [
    fileEntry("a.txt", "/root/a.txt"),
    dirEntry(
        "sub",
        [fileEntry("b.txt", "/root/sub/b.txt"), dirEntry("deep", [fileEntry("c.txt", "/root/sub/deep/c.txt")], "/root/sub/deep")],
        "/root/sub",
    ),
]);
assert.deepEqual(paths(await collectDroppedFiles(dt([tree]))), ["root/a.txt", "root/sub/b.txt", "root/sub/deep/c.txt"]);

// Multiple directories + a loose file dropped together: the case that broke the sequential walk.
const multi = await collectDroppedFiles(
    dt([
        dirEntry("proj", [fileEntry("index.ts", "/proj/index.ts"), dirEntry("src", [fileEntry("app.ts", "/proj/src/app.ts")], "/proj/src")]),
        dirEntry("docs", [fileEntry("readme.md", "/docs/readme.md")]),
        fileEntry("top.txt"),
    ]),
);
assert.deepEqual(paths(multi), ["docs/readme.md", "proj/index.ts", "proj/src/app.ts", "top.txt"]);

// A single dropped file keeps its basename.
assert.deepEqual(paths(await collectDroppedFiles(dt([fileEntry("note.md")]))), ["note.md"]);

// Ignored dirs (node_modules) + secrets (.env) are skipped; `.git` is KEPT (repo stays connected); onFile fires
// once per captured file.
const withJunk = dirEntry("proj", [
    fileEntry("index.ts", "/proj/index.ts"),
    dirEntry("node_modules", [fileEntry("dep.js", "/proj/node_modules/dep.js")], "/proj/node_modules"),
    dirEntry(".git", [fileEntry("config", "/proj/.git/config")], "/proj/.git"),
    fileEntry(".env", "/proj/.env"),
]);
const scanned = [];
const junk = await collectDroppedFiles(dt([withJunk]), (path) => scanned.push(path));
assert.deepEqual(paths(junk), ["proj/.git/config", "proj/index.ts"]);
assert.deepEqual(scanned.toSorted(), ["proj/.git/config", "proj/index.ts"]);

// An already-aborted signal stops the walk immediately (cancel): no files captured.
const canceled = await collectDroppedFiles(
    dt([dirEntry("big", [fileEntry("a.txt", "/big/a.txt"), fileEntry("b.txt", "/big/b.txt")])]),
    undefined,
    AbortSignal.abort(),
);
assert.deepEqual(paths(canceled), []);

// No entry API (some sources expose files but not webkitGetAsEntry) → fall back to the flat file list.
const fallback = await collectDroppedFiles({ items: [], files: [{ name: "x.txt" }] });
assert.deepEqual(paths(fallback), ["x.txt"]);

// A directory whose readEntries never calls back (Chromium's validity-window hang) is SKIPPED after the timeout;
// the rest of the drop still resolves. Uses a tiny timeout override so the check stays fast.
const neverEntry = {
    isFile: false,
    isDirectory: true,
    name: "hung",
    fullPath: "/hung",
    createReader: () => ({ readEntries: () => {} }), // never invokes the callback
};
const partial = await collectDroppedFiles(dt([fileEntry("ok.txt", "/ok.txt"), neverEntry]));
assert.deepEqual(paths(partial), ["ok.txt"]); // hung subtree dropped, ok.txt survives

// A fullPath CYCLE (a followed symlink pointing back at itself) resolves instead of recursing forever.
const cyclic = { isFile: false, isDirectory: true, name: "loop", fullPath: "/loop" };
cyclic.createReader = () => {
    let drained = false;
    return {
        readEntries: (cb) => {
            if (drained) {
                cb([]);
                return;
            }
            drained = true;
            cb([fileEntry("real.txt", "/loop/real.txt"), cyclic]); // child re-references the parent
        },
    };
};
assert.deepEqual(paths(await collectDroppedFiles(dt([cyclic]))), ["loop/real.txt"]);

// A root webkitGetAsEntry can't resolve (null) is reported as skipped, not silently swallowed.
const skippedOnly = await collectDroppedFiles(dt([null]));
assert.deepEqual(skippedOnly.files, []);
assert.equal(skippedOnly.skipped, 1);

// filesToEntries: webkitRelativePath (a picked folder) wins over the basename.
const picked = filesToEntries([
    { name: "p.png", webkitRelativePath: "" },
    { name: "q.ts", webkitRelativePath: "folder/q.ts" },
]);
assert.deepEqual(
    picked.map((e) => e.path),
    ["p.png", "folder/q.ts"],
);

// isRootGitPath: only the workspace ROOT's own .git (the /work pointer file the daemon also refuses), the drop
// that produces it is a repo's CONTENTS landing at the root.
assert.equal(isRootGitPath(".git"), true);
assert.equal(isRootGitPath(".git/config"), true);
assert.equal(isRootGitPath(".git/objects/ab/cdef"), true);
// A NESTED repo's .git travels: dropping the repo's FOLDER, or its contents onto a folder, both land here.
assert.equal(isRootGitPath("repo/.git"), false);
assert.equal(isRootGitPath("repo/.git/config"), false);
// Name-alike siblings at the root are ordinary content: segment-exact, not a prefix match.
assert.equal(isRootGitPath(".gitignore"), false);
assert.equal(isRootGitPath(".github/workflows/ci.yml"), false);
assert.equal(isRootGitPath(".gitmodules"), false);

console.log("dropEntries.check: OK");
