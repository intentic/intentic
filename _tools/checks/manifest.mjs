// The one list of checks that read the checkout; CI, the pre-push hook, the turn-ending check and `pnpm checks` all
// read it, so a check exists once and runs everywhere. Each check is its own process (lib/report.mjs): problems to
// stderr and exit 1, else what it vouched for to stdout and exit 0.
// `needs`:
// checkout tracked files only, no install, no network
// git checkout plus history (a merge-base, a range), still no install
// node_modules optional: the check attempts what needs an install, vouches for less without it
// `gate`:
// code the tree is broken or unbuildable; refused wherever this list is read
// tidy a cost to readers, not a break; a warning at the push, a refusal only for a turn's own new lines, a refusal in
// CI's tidy job
// A new check enters as tidy and is promoted to code once a run record shows only true failures.
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
    { id: "run-settings", file: "run-settings-tier.mjs", needs: "checkout", gate: "tidy", about: "effort, extended thinking and speed are one control" },
    { id: "vue-templates", file: "vue-templates.mjs", needs: "node_modules", gate: "code", about: "every .vue template compiles (attempted where vue is installed)" },
];
