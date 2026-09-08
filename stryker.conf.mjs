// Mutation testing: what the suite would notice if the code broke, not just whether it ran. Opt-in marker for the
// `test-strength` chore (sandbox-contract/src/chores), which refuses to run without it. Mutates the daemon's
// steering/rule-resolution code, the part expensive to get wrong; a real dependency, since `pnpm dlx` can't resolve its
// own plugins.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager: "pnpm",
    testRunner: "vitest",
    // Named explicitly: Stryker's default glob resolves from core's own node_modules, missing siblings under pnpm.
    plugins: ["@stryker-mutator/vitest-runner"],
    // No root vitest config exists; pointed at the daemon's, whose `sourceAlias` resolves the contract from source, so
    // the contract's chores get mutated under it too.
    vitest: {
        configFile: "_sandbox/sandbox/vitest.config.ts",
        // Without this, vitest collects every package's suites from the sandbox copy, dies on the first `.vue` import.
        dir: "_sandbox/sandbox",
    },
    reporters: ["json"],
    // Re-runs only the tests that could catch each mutant; safe since the unit suite shares no state between files.
    coverageAnalysis: "perTest",
    mutate: [
        "_sandbox/sandbox/src/agent/verification/agent-diagnostics.ts",
        "_sandbox/sandbox/src/agent/verification/agent-removals.ts",
        "_sandbox/sandbox/src/agent/tools/agent-shell-edits.ts",
        "_sandbox/sandbox/src/agent/verification/agent-test-strength.ts",
        "_sandbox/sandbox/src/agent/verification/agent-tests.ts",
        "_sandbox/sandbox/src/agent/verification/agent-verification.ts",
        "_sandbox/sandbox/src/agent/verification/agent-viewing.ts",
        "_sandbox/sandbox/src/agent/verification/turn-checks.ts",
        "_sandbox/sandbox/src/rules/*.ts",
        "_shared/sandbox-contract/src/chores/*.ts",
        "!**/*.test.ts",
        "!**/*.integration.test.ts",
        "!**/testing.ts",
        "!**/*.testing.ts",
    ],
    // For Stryker's own exit code and report colour, not the chore: its real floor lives in chores.ts. `break: null`
    // keeps a low score from failing this command, since the probe already runs it with `|| true`.
    thresholds: { high: 80, low: 60, break: null },
    // Outside the repo tree: a sandbox copy per worker here would drag into the iq index and every file listing.
    tempDirName: "/tmp/intentic-stryker",
    incrementalFile: "/tmp/intentic-stryker/incremental.json",
};
