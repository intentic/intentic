// The checks' one door to the two exception forms (the site pragma and the `Allow:` trailer, parsed in
// @intentic/constants/allow so a guard suite reads them the same way). A check reads a site with `allowedAt`; a run
// that judges a range (the check after a land, the push) asks `allowedInRange` which checks that range excused.
import { spawnSync } from "node:child_process";
import { allowTrailers } from "../../constants/src/allow.mjs";

export { allowedAt, allowTrailers, pragmaReason } from "../../constants/src/allow.mjs";

/**
 * The checks an `Allow: <check> — <reason>` trailer in `base..head` excuses, each with its reasons; empty when git
 * cannot read the range, which excuses nothing.
 */
export const allowedInRange = (root, base, head = "HEAD") => {
    const listed = spawnSync("git", ["log", "--format=%(trailers:key=Allow)", `${base}..${head}`], { cwd: root, encoding: "utf8" });
    const allowed = new Map();
    if (listed.status !== 0) {
        return allowed;
    }
    for (const { check, reason } of allowTrailers(listed.stdout)) {
        allowed.set(check, [...(allowed.get(check) ?? []), reason]);
    }
    return allowed;
};
