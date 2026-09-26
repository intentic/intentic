// Pins that a change git cannot list fails its measurement, since linting nothing would pass the land's judgment silently.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changesSince } from "../lib/git.mjs";
import { measureChange } from "./measure-change.mjs";

const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "measure-change-"));
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    run("init", "-q");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    return { root, head: run("rev-parse", "HEAD") };
};

test("a base git cannot diff against is a lint that could not run, naming git's own error", () => {
    const { root } = repo();
    try {
        const lint = measureChange(root, "no-such-rev", { verdicts: [] }).filter(({ source }) => source === "lint");
        assert.equal(lint.length, 1);
        assert.match(
            lint[0].unit,
            /^lint could not run: git could not list what changed since no-such-r: git diff --name-only --no-renames no-such-rev: fatal: ambiguous argument 'no-such-rev'/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a base git can answer lists every changed path, untracked included", () => {
    const { root, head } = repo();
    try {
        writeFileSync(join(root, "new.md"), "x\n");
        assert.deepEqual(changesSince(root, head), { paths: ["new.md"] });
        assert.match(changesSince(root, "no-such-rev").error, /^git diff --name-only --no-renames no-such-rev: fatal: /);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
