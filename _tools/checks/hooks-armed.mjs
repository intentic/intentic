#!/usr/bin/env node
/* THE HOOKS ARE ARMED. A hook git cannot execute is a hook git SKIPS: with a hint, not an error, and the push
 * sails past every gate above, the contract-shrink gate included. That is not hypothetical: the checkout this
 * was written against had a pre-push born 100644, healed to 100755 in the index on 2026-08-07, and never once
 * healed ON DISK: every later update reached its working tree as a patch, which keeps the mode a file already
 * has. The gate there said "undeclared shrink", the hook there said nothing, and an undeclared contract break
 * reached main.
 *
 * RE-ARMED, NOT REFUSED, and this is the one check here that repairs rather than reports. Every other check
 * describes the tree that is about to be pushed and cannot know what the author meant. This one describes a
 * bit on the pusher's own disk that carries no intent whatsoever, and the fix is a chmod this process is
 * already entitled to make. A mode-only flip in the index is invisible to every existing working tree FOREVER
 * (git rewrites contents, never modes), so the install-time repair (githooks.mjs) alone never reaches a clone
 * that does not reinstall. Still reported when the chmod itself fails: a hook nobody can arm is the real
 * finding. Windows has no executable bit and never runs these hooks through one. */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

const disarmed = [];
const rearmed = [];
const hooksDir = join(root, ".githooks");
if (process.platform !== "win32" && existsSync(hooksDir)) {
    for (const hook of readdirSync(hooksDir)) {
        const path = join(hooksDir, hook);
        if ((statSync(path).mode & 0o111) !== 0) {
            continue;
        }
        try {
            chmodSync(path, 0o755);
            rearmed.push(hook);
        } catch (error) {
            disarmed.push(
                `.githooks/${hook} is not executable and could not be made executable (${error.message}): git skips it with a hint and the push bypasses every gate`,
            );
        }
    }
}

finish([["Git hooks are disarmed on this checkout, so pushes skip these gates entirely", disarmed]], [
    rearmed.length > 0
        ? `git hooks: re-armed ${rearmed.join(", ")} (checked out without the executable bit, so git was skipping ${rearmed.length === 1 ? "it" : "them"}), and now every .githooks file runs`
        : `git hooks: every .githooks file is executable, so the pre-push gate actually runs`,
]);
