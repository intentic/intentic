/* THE ONE LIST OF CHECKS THAT READ THE CHECKOUT, and where each one runs. Every gate that was ever "right but
 * unrun" in this repository was right in a script nothing listed: `pnpm check` chained eleven of them by hand
 * and could not run in a worktree, so five of them were red for weeks with nothing to say so. This list is what
 * CI's preflight job, the pre-push hook, the turn-ending check and `pnpm check` all read, so a check exists
 * exactly once and runs everywhere the list is read.
 *
 * `needs` says what a check has to have under it:
 *   checkout      the tracked files and nothing else; no install, no network. Every one of these runs from a
 *                 clone that has never installed, which is what CI's preflight and the pre-push hook are.
 *   git           the checkout plus its history (a merge-base, a range); still no install.
 *   node_modules  optional: the check attempts what needs an install and vouches for less when it is absent.
 *
 * Every check is its own process with one contract (lib/report.mjs): problems to stderr and exit 1, or what it
 * vouched for to stdout and exit 0. That is what lets run.mjs run them side by side, and lets any one be run
 * alone by hand: `node _tools/checks/<file>`. */
export const CHECKS = [
    { id: "control-chars", file: "control-chars.mjs", needs: "checkout", about: "no literal control bytes in tracked text" },
    { id: "lockfile", file: "lockfile-drift.mjs", needs: "checkout", about: "pnpm-lock.yaml records the manifests and carries nothing unreachable" },
    { id: "test-programs", file: "test-programs.mjs", needs: "checkout", about: "tests are type-checked, budgeted, mocked whole, and emitted in order" },
    { id: "workflows", file: "workflow-policy.mjs", needs: "checkout", about: "the fork boundary, permission ceilings, provenance runners, tag triggers" },
    { id: "release-headings", file: "release-headings.mjs", needs: "checkout", about: "the release-body headings are spelled the same by writer and parsers" },
    { id: "contract-shrink", file: "contract-shrink.mjs", needs: "git", about: "a shrunk wire contract arrives declared" },
    { id: "hooks-armed", file: "hooks-armed.mjs", needs: "checkout", about: ".githooks are executable (re-armed, not refused)" },
    { id: "invariant-registry", file: "invariant-registry.mjs", needs: "checkout", about: "every daemon subsystem registers a runtime invariant or says why not" },
    { id: "daemon-boundaries", file: "daemon-boundaries.mjs", needs: "checkout", about: "no new whole-Services taker, no new mutual subsystem cycle" },
    { id: "publish-set", file: "publish-set.mjs", needs: "checkout", about: "PUB is dependency-closed and topologically ordered" },
    { id: "engines", file: "engines-blessed.mjs", needs: "checkout", about: "engines.json blesses only versions this repo pins" },
    { id: "build-cache", file: "build-cache-mounts.mjs", needs: "checkout", about: "sandbox image fragments keep the build-cache contract" },
    { id: "paths", file: "path-literals.mjs", needs: "checkout", about: "no hand-spelled roots and no counted ones (ratcheted)" },
    { id: "tailwind", file: "tailwind-bypass.mjs", needs: "checkout", about: "no arbitrary colours or pixel sizes in class attributes" },
    { id: "display", file: "display-descenders.mjs", needs: "checkout", about: "clipped display type keeps its descender clearance" },
    { id: "rows", file: "row-tiers.mjs", needs: "checkout", about: "every list draws at its RowGroup's tier" },
    { id: "buttons", file: "button-tiers.mjs", needs: "checkout", about: "every action button is <Button>" },
    { id: "inputs", file: "input-tiers.mjs", needs: "checkout", about: "every field is ui-field-box" },
    { id: "vue-templates", file: "vue-templates.mjs", needs: "node_modules", about: "every .vue template compiles (attempted where vue is installed)" },
];
