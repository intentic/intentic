#!/usr/bin/env node
// Runs as a `prepare` script on every install (developer clone, Docker build with no `.git`, Windows CI), so it's JS,
// not the shell one-liner it replaces. Points git at the repository's hooks and at its merge driver for derived files.
// Re-arms each hook's executable bit on disk since a patched update leaves a file's mode alone, and git silently skips
// a non-executable hook. No git repo is normal, not an error; nothing here fails an install.
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

// This file's own location, not the cwd: `prepare` runs from wherever the installer chose.
const root = repoRoot(import.meta.url);

const git = (...args) => execFileSync(`git`, args, { cwd: root, stdio: `ignore` });

try {
    git(`rev-parse`, `--git-dir`);
} catch {
    process.exit(0);
}

try {
    git(`config`, `core.hooksPath`, `.githooks`);
} catch (error) {
    console.warn(`git hooks not configured (${error.message}): commits still work, they just skip the local checks`);
}

// A file .gitattributes marks `merge=derived` is a function of the tree it sits in: a rebase or a merge keeps the side
// it lands on (`true` leaves the current version as the result), and fixers.mjs writes it again from what is there now.
try {
    git(`config`, `merge.derived.name`, `a derived file: keep this side, fixers.mjs writes it again`);
    git(`config`, `merge.derived.driver`, `true`);
} catch (error) {
    console.warn(`derived-file merge driver not configured (${error.message}): a rebase can stop on a generated file`);
}

// Re-arms unconditionally; a missing bit just skips the hook (with a hint), and chmod no-ops on Windows.
try {
    for (const hook of readdirSync(join(root, `.githooks`))) {
        chmodSync(join(root, `.githooks`, hook), 0o755);
    }
} catch (error) {
    console.warn(`git hooks not re-armed (${error.message}): a non-executable hook is silently skipped by git`);
}
