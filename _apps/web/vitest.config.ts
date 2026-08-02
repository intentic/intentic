import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";
import { sourceAliases } from "./source-aliases.ts";

export default defineConfig({
    // SFCs have to compile for a test to mount one. Most suites here test plain .ts (composables, pure
    // projections) and never touch this, but the pieces whose whole contract is what they RENDER — a chart's
    // geometry, say — can only be pinned by mounting them.
    plugins: [vue()],
    // The same source-first aliases as vite.config.ts — without them, tests resolve first-party extensions to
    // pnpm's injected node_modules copies, whose extension-api snapshot lacks src and (on a fresh CI install)
    // dist. See source-aliases.ts.
    resolve: {
        alias: sourceAliases(),
        // Every workspace package exports an `@intentic/src` condition pointing at its .ts source, and none of
        // them ship a dist in a fresh checkout. Vite applies the condition for the app build; vitest resolves
        // with node's defaults unless told, which is why a suite that reached one of the un-aliased libs
        // (@intentic/sandbox-run, @intentic/constants) failed to LOAD rather than to assert.
        conditions: [`@intentic/src`],
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
        /* These budgets bound a HANG; they do not measure latency, and nothing here should be near them.
         *
         * Module loading is on the same clock as the assertions. A full run of this package spends ~170s
         * importing and ~90s transforming against ~50s actually running tests — the composables are singletons,
         * so ~90 `await import()` calls re-enter the graph from inside test bodies and hooks, and a mounted
         * component pulls a Vue view's whole subtree. Idle, the heaviest of those costs ~1s; on a runner with
         * every core busy it costs ten times that, and vitest's 5s/10s defaults then fail whichever file lost
         * the race — a different one each run, which reads as flakiness rather than as contention. Worse, a
         * timed-out test keeps running: its in-flight work lands on the NEXT test's mocks, so one slow import
         * reports as two failures, the second pointing at innocent code.
         *
         * Prefer taking the load off the clock over raising these further: a static import costs the same but
         * is paid during collection, where it is bounded by the run rather than by a test. It works whenever
         * the file's hoisted setup only installs globals (staleChunk.test.ts, startAgent.test.ts); when a
         * `vi.mock` factory closes over module-scope state, hoist the STATE too rather than deferring the
         * import, or the factory reads it in its temporal dead zone (codebaseHealthPanel.test.ts).
         *
         * ALREADY MEASURED, on this suite, with every core busy — don't re-derive these:
         *  - `deps.optimizer` (esbuild prebundling): no effect (5.42s vs 5.44s). What costs here is FIRST-party
         *    source pulled through the alias map above, which the optimizer never sees.
         *  - `pool: "threads"`: ~20% less transform+import CPU, and no wall-clock win at all under contention
         *    (18.8s vs 18.8s) because jsdom setup gets dearer in a thread (~60s vs ~45s). Not worth changing
         *    what a crashing worker takes down with it.
         *  - `isolate: false`: 21 failures paired with threads, and with forks it shares a module registry
         *    across files in a package built on singletons — a pass there means the file order was lucky.
         *  - capping `maxWorkers` (turbo runs every package's vitest at once): 2.5× SLOWER, 55s vs 22s for the
         *    whole repo. Over-subscription is not what hurts; the scheduler handles it.
         * What is left is the shape of the tests themselves: ~90 `await import()` calls, most of them a
         * singleton being reset. Those are load-bearing, and this is the budget that covers them.
         */
        testTimeout: 20_000,
        hookTimeout: 30_000,
    },
});
