// Holds package-readmes.mjs to the question `intentic-docs validate` asks: the same packages, the same missing pages.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { discoverPackages, readmeProblem } from "./lib/readme-packages.mjs";
import { root } from "./lib/repo.mjs";

const cli = spawnSync("intentic-docs", ["--help"], { encoding: "utf8" }).error === undefined;
const skip = cli ? false : "intentic-docs is not on PATH (it ships with the documentation extension, not this repository)";

// What the CLI reports, split by kind: the packages it finds no README.md for, and the pages with no lead sentence.
const validate = (workspace, repo) => {
    const result = spawnSync("intentic-docs", ["validate", "--root", workspace, "--repo", repo, "--from", "published"], { encoding: "utf8" });
    const lines = result.stderr.split("\n");
    const pick = (pattern) => lines.flatMap((line) => pattern.exec(line)?.slice(1, 2) ?? []).toSorted();
    return {
        missing: pick(/^- (.+) has no README\.md — /),
        noLead: pick(/^- (.+)\/README\.md has no lead sentence /),
    };
};

const ours = (repoRoot) => {
    const packages = discoverPackages(repoRoot);
    const of = (kind) => packages.filter((dir) => readmeProblem(repoRoot, dir) === kind);
    return { missing: of("missing"), noLead: of("no-lead") };
};

const tree = (files) => {
    const workspace = mkdtempSync(join(tmpdir(), "package-readmes-"));
    for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(workspace, "r", path)), { recursive: true });
        writeFileSync(join(workspace, "r", path), body);
    }
    return workspace;
};

const FIXTURE = {
    "a/package.json": "{}",
    "a/README.md": "# a\n\nThe a package, described.\n",
    "b/Cargo.toml": "[package]\n",
    "c/go.mod": "module c\n",
    "c/README.md": "# c\n\n## Key files\n",
    "d/pyproject.toml": "",
    "d/README.md": "# d\n\n| table |\n\nProse after a table counts.\n",
    "a/tests/x/package.json": "{}",
    "node_modules/z/package.json": "{}",
    ".hidden/p/package.json": "{}",
    "nested/.git/HEAD": "",
    "nested/inner/package.json": "{}",
    "deep/1/2/3/4/package.json": "{}",
    "deep/1/2/3/4/5/package.json": "{}",
};

test("the check finds the packages and the bare pages the documentation tool's rules name, by value", () => {
    const workspace = tree(FIXTURE);
    try {
        assert.deepEqual(discoverPackages(join(workspace, "r")), ["a", "b", "c", "d", "deep/1/2/3/4"]);
        assert.deepEqual(ours(join(workspace, "r")), { missing: ["b", "deep/1/2/3/4"], noLead: ["c"] });
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("on the same tree the documentation tool reports exactly what the check does", { skip }, () => {
    const workspace = tree(FIXTURE);
    try {
        assert.deepEqual(validate(workspace, "r"), ours(join(workspace, "r")));
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("on this repository the documentation tool and the check miss the same READMEs", { skip }, () => {
    assert.deepEqual(validate(dirname(root), basename(root)), ours(root));
});
