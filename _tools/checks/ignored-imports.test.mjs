// Pins how ignored-imports resolves a relative specifier and what it reads as an import git never lands: against a
// throwaway repository, since the answer is git's (check-ignore, and which index lists what).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { candidatesOf, ignoredImports, trackedIn } from "./lib/ignored-imports.mjs";

// A git run from inside a hook or the turn check inherits its GIT_DIR and GIT_INDEX_FILE, which would point the scratch
// repository's git at the real one.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

test("a compiled name means its source, an extensionless one its implied files, a query is dropped", () => {
    assert.deepEqual(candidatesOf("a/b/x.ts", "./y.js"), ["a/b/y.js", "a/b/y.ts", "a/b/y.tsx", "a/b/y.mts"]);
    assert.deepEqual(candidatesOf("a/b/x.ts", "../c/z.mjs"), ["a/c/z.mjs", "a/c/z.mts"]);
    assert.deepEqual(candidatesOf("a/x.ts", "./icon.svg?raw"), ["a/icon.svg"]);
    assert.deepEqual(candidatesOf("a/x.ts", "./w.config").slice(0, 3), ["a/w.config", "a/w.config.ts", "a/w.config.tsx"]);
    assert.ok(candidatesOf("a/x.ts", "./lib").includes("a/lib/index.ts"));
    assert.deepEqual(candidatesOf("a/x.ts", "./lib/"), [".ts", ".tsx", ".mts", ".js", ".mjs", ".vue"].map((extension) => `a/lib/index${extension}`));
    assert.deepEqual(candidatesOf("a/x.ts", "../../outside.js"), []);
});

const scratch = (files) => {
    const root = mkdtempSync(join(tmpdir(), "ignored-imports-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, env: ENV, encoding: "utf8" });
    git("init", "-q");
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    git("add", "-A");
    return { root, git };
};

const judge = (root, env = ENV) => {
    const listed = trackedIn(root, env);
    return ignoredImports({
        root,
        subjects: listed.filter((path) => /\.m?[jt]s$/.test(path)),
        tracked: new Set(listed),
        read: (path) => readFileSync(join(root, path), "utf8"),
        exists: (path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true,
        env,
    }).map(({ file, line, target, rule }) => `${file}:${line} ${target} (${rule})`);
};

// The break that shipped: suites.mjs imported dist-staleness.mjs, which `**/dist-*` kept out of the commit.
test("an import of a file a pattern swallows is found with the rule, whether or not the file is on disk", () => {
    const { root } = scratch({
        ".gitignore": "**/dist-*\n",
        "tools/testing/bin/suites.mjs": `import { staleDist } from "../../scripts/build/dist-staleness.mjs";\nconst later = await import("../../scripts/build/dist-later.mjs");\n`,
        "tools/scripts/build/dist-staleness.mjs": "export const staleDist = 1;\n",
    });
    try {
        const shipped = [
            "tools/testing/bin/suites.mjs:1 tools/scripts/build/dist-staleness.mjs (.gitignore:1 **/dist-*)",
            "tools/testing/bin/suites.mjs:2 tools/scripts/build/dist-later.mjs (.gitignore:1 **/dist-*)",
        ];
        assert.deepEqual(judge(root), shipped);
        // A fresh clone, as CI has it: the file was never there, and the rule still says why.
        rmSync(join(root, "tools/scripts/build/dist-staleness.mjs"));
        assert.deepEqual(judge(root), shipped);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a tracked target, a new file a `!` exception lets in, a new source beside ignored output, a missing file nothing ignores, a package name and a fixture string are not", () => {
    const { root } = scratch({
        ".gitignore": "src/generated/*\n!src/generated/kept.ts\nsrc/stale.js\n",
        "src/main.ts": [
            `import { a } from "./a.js";`,
            `import { kept } from "./generated/kept.js";`,
            `import { stale } from "./stale.js";`,
            `import { gone } from "./gone.js";`,
            `import { z } from "zod";`,
            `const fixture = ["x.ts", 'import { b } from "./generated/b";'];`,
            "",
        ].join("\n"),
        "src/a.ts": "export const a = 1;\n",
    });
    try {
        // Written after the scratch index was filled: on disk and not yet added, as a file is the moment it is written.
        mkdirSync(join(root, "src/generated"));
        writeFileSync(join(root, "src/generated/kept.ts"), "export const kept = 1;\n");
        writeFileSync(join(root, "src/stale.ts"), "export const stale = 1;\n");
        writeFileSync(join(root, "src/stale.js"), "export const stale = 0;\n");
        assert.deepEqual(judge(root), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// The turn check's index lists every untracked file git does not ignore, as intent-to-add: a new file that is not
// ignored lands, one that is ignored does not.
test("tracked is whatever index GIT_INDEX_FILE names", () => {
    const { root, git } = scratch({ ".gitignore": "**/dist-*/\n", "src/main.ts": `import { s } from "./dist-staleness.js";\nimport { b } from "./dist-bin/b.js";\n` });
    const indexes = mkdtempSync(join(tmpdir(), "ignored-imports-index-"));
    try {
        writeFileSync(join(root, "src/dist-staleness.ts"), "export const s = 1;\n");
        mkdirSync(join(root, "src/dist-bin"));
        writeFileSync(join(root, "src/dist-bin/b.ts"), "export const b = 1;\n");
        const index = join(indexes, "index");
        copyFileSync(join(root, git("rev-parse", "--git-path", "index").trim()), index);
        const turn = { ...ENV, GIT_INDEX_FILE: index };
        execFileSync("git", ["add", "--intent-to-add", "--", "."], { cwd: root, env: turn });
        assert.ok(trackedIn(root, turn).includes("src/dist-staleness.ts"));
        // Named by the file on disk, which is the one that will not land.
        assert.deepEqual(judge(root, turn), ["src/main.ts:2 src/dist-bin/b.ts (.gitignore:1 **/dist-*/)"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(indexes, { recursive: true, force: true });
    }
});
