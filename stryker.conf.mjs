import { INTEGRATION_MARKERS, MANUAL_MARKERS } from "./_tools/constants/src/test-suites.mjs";

// Mutation testing: what the suite would notice if the code broke, not just whether it ran. Opt-in marker for the
// `test-strength` chore (the maintenance extension's book, src/chores/probes.ts there), which refuses to run without
// it. Mutates the daemon's steering/rule-resolution code, the part expensive to get wrong; a real dependency, since
// `pnpm dlx` can't resolve its own plugins. The contract's chore book left for that extension on 2026-11-26 (its copy
// here is frozen), so it is no longer mutated here.

// The unit suites of the package under mutation; `suites` is not used since its integration run would spend the
// machine per mutant.
const UNIT_RUN = `bun test --conditions=@intentic/src ${[...INTEGRATION_MARKERS, ...MANUAL_MARKERS].map((marker) => `--path-ignore-patterns '**/*.${marker}.test.*'`).join(" ")}`;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager: "pnpm",
    // Stryker has no bun runner: the command runner spawns the suites per mutant, so per-test coverage is unavailable
    // and every mutant costs one full run of the package.
    testRunner: "command",
    plugins: [],
    commandRunner: {
        command: `cd _sandbox/sandbox && ${UNIT_RUN}`,
    },
    // In place: a sandbox copy holds only the root node_modules, through which no package resolves under pnpm.
    inPlace: true,
    reporters: ["json"],
    coverageAnalysis: "off",
    mutate: [
        "_sandbox/sandbox/src/agent/verification/agent-diagnostics.ts",
        "_sandbox/sandbox/src/agent/tools/agent-shell-edits.ts",
        "_sandbox/sandbox/src/agent/verification/agent-verification.ts",
        "_sandbox/sandbox/src/agent/verification/agent-viewing.ts",
        "_sandbox/sandbox/src/agent/verification/turn-checks.ts",
        "_sandbox/sandbox/src/rules/*.ts",
        "!**/*.test.ts",
        "!**/*.integration.test.ts",
        "!**/testing.ts",
        "!**/*.testing.ts",
    ],
    // For Stryker's own exit code and report colour, not the chore: its real floor lives in the maintenance book's
    // chores.ts. `break: null` keeps a low score from failing this command, since the probe already runs it with
    // `|| true`.
    thresholds: { high: 80, low: 60, break: null },
    // Outside the repo tree, so a run's files never drag into a search or a file listing.
    tempDirName: "/tmp/intentic-stryker",
    incrementalFile: "/tmp/intentic-stryker/incremental.json",
};
