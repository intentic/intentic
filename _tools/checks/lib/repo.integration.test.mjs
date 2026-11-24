import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathspecTest } from "./repo.mjs";

// A `--paths` run answers `git ls-files -z <spec>` from the whole listing (repo.mjs's `git` once `rememberGit()` asks),
// so the answer must be git's own, path for path and in its order. Held against git itself in a tree shaped to catch
// the places wildmatch without WM_PATHNAME differs from a shell glob: a `*` crosses `/`, and `**/` matches no top-level file.
const dir = mkdtempSync(join(tmpdir(), "repo-pathspec-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const FILES = [
    "a.vue",
    "a.ts",
    "b.mjs",
    "_x.ts",
    "_shared/one/package.json",
    "_shared/one/src/deep/c.ts",
    "_sandbox/sandbox/src/d.ts",
    "_sandbox/sandbox/src/sub/e.vue",
    "_sandbox/sandbox/srcx/f.ts",
    "_extensions/x/package.json",
    "_extensions/x/sub/package.json",
    "_editor/web/src/g.vue",
    "notes/a.ts.md",
    "dots.in.name/h.ts",
    "plus+dir/i.ts",
];
for (const file of FILES) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), "");
}
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
git("init", "-q");
git("add", "-A");
const whole = git("ls-files", "-z").split("\0").filter(Boolean);

const SPECS = [
    "*.ts",
    "*.vue",
    "**/*.vue",
    "**/*.ts",
    "_*",
    "_shared/**",
    "_sandbox/sandbox/src/*",
    "_sandbox/sandbox/src",
    "_extensions/*/package.json",
    "_editor/web/src/**",
    "_shared/one/package.json",
    "dots.in.name/*",
    "plus+dir/*",
    "*/package.json",
    "_sandbox/**/e.vue",
    "nothing/*",
    "a**s",
    "**.ts",
    "_sandbox**e.vue",
    "*",
    "_*/*/*.ts",
];

test("every pathspec shape the checks ask is answered as git answers it", () => {
    for (const spec of SPECS) {
        const matches = pathspecTest(spec);
        assert.notEqual(matches, undefined, spec);
        assert.deepEqual(
            whole.filter((path) => matches(path)),
            git("ls-files", "-z", spec).split("\0").filter(Boolean),
            spec,
        );
    }
});

test("a shape it does not model is left to git", () => {
    for (const spec of ["a?.ts", "[ab].ts", "a\\*.ts", ":(glob)*.ts", ""]) {
        assert.equal(pathspecTest(spec), undefined, spec);
    }
});
