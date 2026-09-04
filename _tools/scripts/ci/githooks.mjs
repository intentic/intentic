#!/usr/bin/env node
/* POINT GIT AT `.githooks`: the one thing `pnpm install` does to the clone rather than to `node_modules`.
 *
 * This is a `prepare` script, which means it runs after EVERY install, in every context an install happens in:
 * a developer's clone, a Docker build whose context carries no `.git`, and a Windows CI runner. That last one is
 * why this is JavaScript and not the shell one-liner it used to be: `chmod`, `/dev/null` and `|| true` are all
 * POSIX, pnpm hands lifecycle scripts to `cmd.exe` on Windows, and the install died there before a single
 * package was linked. A repo-wide install step cannot be written in a language a third of the machines running
 * it do not speak.
 *
 * The `chmod +x` the shell version ran was removed once the hooks were tracked executable: a clone checks
 * them out executable, so there seemed to be nothing left to fix up. A real checkout proved otherwise: its
 * pre-push had been BORN 100644, every later update reached the working tree as a patch (which keeps the mode
 * the file already had on disk), and the index saying 100755 never once touched the file. Git's answer to a
 * hook it cannot execute is a HINT and a push that sails through every gate the hook carries, which is how an
 * undeclared contract break reached main past a check that had said no. So the repair is back, aimed at the
 * disk rather than the index: prepare is the one step that runs on every machine, and it re-arms rather than
 * trusts. The hooks-armed check (_tools/checks/) makes the same repair on every `pnpm test` and `pnpm typecheck`, which is what
 * covers the clone that installed before the mode was fixed and has had no reason to install since.
 *
 * Two rules, both of which exist because this runs in front of everything else:
 *
 *   • NO GIT REPOSITORY IS NORMAL, NOT AN ERROR. An unpacked tarball and a Docker build context both install
 *     without a work tree, and neither has hooks to configure.
 *   • NOTHING HERE FAILS AN INSTALL. Hooks are a convenience for the person committing; refusing to install a
 *     dependency tree over one is a trade nobody would take. Anything unexpected is said out loud and skipped.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
// By file, not by package name: this is a `prepare` script, so it runs BEFORE the install it belongs to has
// finished linking anything, and a bare specifier resolves through node_modules.
import { repoRoot } from "../../constants/src/node.mjs";

/* This file's own location, not the working directory: `prepare` runs from wherever the installer chose.
 *
 * FOUND, NOT COUNTED. This used to be `dirname(dirname(import.meta.dirname))`, which was right for exactly as
 * long as this file sat directly in `_tools/scripts` — moving it one directory down made it resolve to
 * `_tools`, where `git config` still succeeds (it is inside the repo) and the `.githooks` re-arm below
 * silently finds nothing. That is the same class of quiet failure the header above is about: a hook that is
 * not executable is SKIPPED with a hint, not refused. */
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

// Re-arm, don't trust: a hook without its executable bit is skipped with a hint, not an error. On Windows the
// bit does not exist and chmod is a no-op, so this is safe to run unconditionally.
try {
    for (const hook of readdirSync(join(root, `.githooks`))) {
        chmodSync(join(root, `.githooks`, hook), 0o755);
    }
} catch (error) {
    console.warn(`git hooks not re-armed (${error.message}): a non-executable hook is silently skipped by git`);
}
