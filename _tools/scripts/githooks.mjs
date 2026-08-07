#!/usr/bin/env node
/* POINT GIT AT `.githooks` — the one thing `pnpm install` does to the clone rather than to `node_modules`.
 *
 * This is a `prepare` script, which means it runs after EVERY install, in every context an install happens in:
 * a developer's clone, a Docker build whose context carries no `.git`, and a Windows CI runner. That last one is
 * why this is JavaScript and not the shell one-liner it used to be — `chmod`, `/dev/null` and `|| true` are all
 * POSIX, pnpm hands lifecycle scripts to `cmd.exe` on Windows, and the install died there before a single
 * package was linked. A repo-wide install step cannot be written in a language a third of the machines running
 * it do not speak.
 *
 * The `chmod +x` the shell version ran went with it: the hooks are tracked executable, so a clone checks them
 * out executable and there is nothing left to fix up. Running it every install was how the mode bit stayed
 * absent from the index for as long as it did — the repair ran often enough that nobody saw the wound.
 *
 * Two rules, both of which exist because this runs in front of everything else:
 *
 *   • NO GIT REPOSITORY IS NORMAL, NOT AN ERROR. An unpacked tarball and a Docker build context both install
 *     without a work tree, and neither has hooks to configure.
 *   • NOTHING HERE FAILS AN INSTALL. Hooks are a convenience for the person committing; refusing to install a
 *     dependency tree over one is a trade nobody would take. Anything unexpected is said out loud and skipped.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file's own location, not the working directory: `prepare` runs from wherever the installer chose.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const git = (...args) => execFileSync(`git`, args, { cwd: root, stdio: `ignore` });

try {
    git(`rev-parse`, `--git-dir`);
} catch {
    process.exit(0);
}

try {
    git(`config`, `core.hooksPath`, `.githooks`);
} catch (error) {
    console.warn(`git hooks not configured (${error.message}) — commits still work, they just skip the local checks`);
}
