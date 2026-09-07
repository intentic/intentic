/* THE ONE LIST OF CHECKS THAT READ THE CHECKOUT, and where each one runs. Every gate that was ever "right but
 * unrun" in this repository was right in a script nothing listed: `pnpm check` chained eleven of them by hand
 * and could not run in a worktree, so five of them were red for weeks with nothing to say so. This list is what
 * CI's preflight and tidy jobs, the pre-push hook, the turn-ending check and `pnpm checks` all read, so a check
 * exists exactly once and runs everywhere the list is read.
 *
 * `needs` says what a check has to have under it:
 *   checkout      the tracked files and nothing else; no install, no network. Every one of these runs from a
 *                 clone that has never installed, which is what CI's preflight and the pre-push hook are.
 *   git           the checkout plus its history (a merge-base, a range); still no install.
 *   node_modules  optional: the check attempts what needs an install and vouches for less when it is absent.
 *
 * `gate` says WHAT A FAILURE MEANS, and that decides where it may refuse:
 *   code          the tree does not work or CI cannot build it: a lockfile that does not record the manifests, a
 *                 test file no program type-checks, a workflow that opens the fork boundary, an alias pointing
 *                 at nothing. Refused everywhere it is read: the push, CI's preflight (which the verify groups
 *                 hang off), and the turn when the turn introduced it.
 *   tidy          the tree costs its readers more than it should: a directory of 35 files, a dead link in a
 *                 README, a hand-spelled root, a UI element off the design system, a subsystem with no
 *                 invariant. Real rules with measured costs (docs/audits/), and NOT reasons to stop a push or
 *                 hold a turn that did not cause them. On the day this field was added, 9 of the 11 pushes the
 *                 gate refused were refused by tidy checks in under five seconds, for state (ghost
 *                 directories, a baseline one count too high, a link another agent's land had broken) that no
 *                 one actor had produced and that the agent then sent to fix could not see from its worktree.
 *                 So a tidy failure is a WARNING at the push and at `pnpm verify`, a refusal at the turn only
 *                 for lines the turn itself introduced (verify-turn.mjs judges against HEAD), and a refusal in
 *                 CI's `tidy` job, which reads one commit and gates nothing else in the pipeline.
 *
 * A NEW CHECK ENTERS AS `tidy`. That is the on-ramp: it runs everywhere at once, says what it would refuse, and
 * nobody's push or turn is stopped by a rule that has not yet met every environment it will run in (the day the
 * layout check landed it was green on a fresh clone, red on every persistent CI workspace and red in the owner's
 * tree, for directories git had never heard of). Promote it to `code` once a week of runs has said only true
 * things, in a change of its own, never in the same push as a large rename.
 *
 * Every check is its own process with one contract (lib/report.mjs): problems to stderr and exit 1, or what it
 * vouched for to stdout and exit 0. That is what lets run.mjs run them side by side, and lets any one be run
 * alone by hand: `node _tools/checks/<file>`. */
export const CHECKS = [
    { id: "control-chars", file: "control-chars.mjs", needs: "checkout", gate: "code", about: "no literal control bytes in tracked text" },
    { id: "skill-descriptions", file: "skill-descriptions.mjs", needs: "checkout", gate: "tidy", about: "every skill description fits the catalog budget the prompt pays for on every call" },
    { id: "lockfile", file: "lockfile-drift.mjs", needs: "checkout", gate: "code", about: "pnpm-lock.yaml records the manifests, pins the pnpm package.json names, and carries nothing unreachable" },
    { id: "test-programs", file: "test-programs.mjs", needs: "checkout", gate: "code", about: "tests are type-checked, budgeted, mocked whole, and emitted in order" },
    { id: "workflows", file: "workflow-policy.mjs", needs: "checkout", gate: "code", about: "the fork boundary, permission ceilings, provenance runners, tag triggers" },
    { id: "release-notes", file: "release-headings.mjs", needs: "checkout", gate: "code", about: "the release body: headings spelled the same by writer and parsers, built from a non-empty range" },
    { id: "contract-shrink", file: "contract-shrink.mjs", needs: "git", gate: "code", about: "a shrunk wire contract arrives declared" },
    { id: "hooks-armed", file: "hooks-armed.mjs", needs: "checkout", gate: "code", about: ".githooks are executable (re-armed, not refused)" },
    { id: "invariant-registry", file: "invariant-registry.mjs", needs: "checkout", gate: "tidy", about: "every daemon subsystem registers a runtime invariant or says why not" },
    { id: "daemon-boundaries", file: "daemon-boundaries.mjs", needs: "checkout", gate: "tidy", about: "no new whole-Services taker, no new mutual subsystem cycle" },
    { id: "publish-set", file: "publish-set.mjs", needs: "checkout", gate: "code", about: "PUB is dependency-closed and topologically ordered" },
    { id: "publish-retry", file: "publish-retry.mjs", needs: "checkout", gate: "code", about: "the publish failures a release rides out, and the ones it must not" },
    { id: "release-api", file: "release-api.mjs", needs: "checkout", gate: "code", about: "github.sh answers a question with text or nothing, and fails loudly on a write" },
    { id: "engines", file: "engines-blessed.mjs", needs: "checkout", gate: "code", about: "engines.json blesses only versions this repo pins" },
    { id: "build-cache", file: "build-cache-mounts.mjs", needs: "checkout", gate: "code", about: "sandbox image fragments keep the build-cache contract" },
    { id: "mirror-roots", file: "mirror-roots.mjs", needs: "checkout", gate: "code", about: "build output an agent turn overlays is emptied, never removed" },
    { id: "paths", file: "path-literals.mjs", needs: "checkout", gate: "tidy", about: "no hand-spelled roots and no counted ones (ratcheted)" },
    { id: "layout", file: "layout.mjs", needs: "checkout", gate: "tidy", about: "no ghost directories, no over-full ones, no twin or colliding names, no dead ones (ratcheted)" },
    { id: "md-links", file: "md-links.mjs", needs: "checkout", gate: "tidy", about: "every relative link in the documentation resolves" },
    { id: "alias-targets", file: "alias-targets.mjs", needs: "checkout", gate: "code", about: "every resolver alias points at a path that exists" },
    { id: "tailwind", file: "tailwind-bypass.mjs", needs: "checkout", gate: "tidy", about: "no arbitrary colours or pixel sizes in class attributes" },
    { id: "display", file: "display-descenders.mjs", needs: "checkout", gate: "tidy", about: "clipped display type keeps its descender clearance" },
    { id: "marks", file: "mark-alignment.mjs", needs: "checkout", gate: "tidy", about: "a mark beside text is placed by the `.mark` rule, never by a hand-tuned offset" },
    { id: "rows", file: "row-tiers.mjs", needs: "checkout", gate: "tidy", about: "every list draws at its RowGroup's tier" },
    { id: "buttons", file: "button-tiers.mjs", needs: "checkout", gate: "tidy", about: "every action button is <Button>" },
    { id: "inputs", file: "input-tiers.mjs", needs: "checkout", gate: "tidy", about: "every field is ui-field-box" },
    { id: "vue-templates", file: "vue-templates.mjs", needs: "node_modules", gate: "code", about: "every .vue template compiles (attempted where vue is installed)" },
];
