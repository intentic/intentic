#!/usr/bin/env node
// A non-executable hook is skipped by git silently, not as an error, so a push bypasses every gate above it. Re-arms
// the bit rather than just reporting it, since a mode-only flip never repairs itself in an existing working tree; a
// chmod failure is still reported. Windows has no executable bit.
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
