import { observeGitCommands } from "@intentic/scaffold";
import { turnRunMetrics } from "../agent/run/turn/turn-runs.js";
import { browserSessionMetrics } from "../browser/sessions/browser-sessions.js";
import { startResourceMetrics } from "../platform/resources/resource-metrics.js";
import type { BootPhase } from "./boot-phase.js";

// What this daemon measures about itself while it runs: the resource series answering "what is it holding", and the
// timing of every git run any subsystem makes. Wired once at boot; neither reads back into the code it measures.
export const startDaemonMetrics = ({ config, logger, services, shutdown }: BootPhase): void => {
    const resourceMetrics = startResourceMetrics({
        historyRoot: config.historyRoot,
        logger,
        owners: () => ({
            ...services.resourceOwners(),
            turnRuns: turnRunMetrics(),
            browserSessions: browserSessionMetrics(),
            reaper: services.reaper.metrics(),
            // Surfaces invariant violations in the same resource series already asked "what is this daemon holding".
            invariants: { violations: services.invariants.violations().length },
        }),
    });
    shutdown.push(() => resourceMetrics.stop());

    // Every git run is attributed to the perf tracker. `dir` is trimmed workspace-relative to keep lines short; `args`
    // drops trailing pathspecs (could be hundreds) but keeps the subcommand.
    observeGitCommands(({ dir, args, ms, execMs, attempts, failed, forked, queueDepth }) => {
        const fields = {
            git: args.slice(0, 3).join(" "),
            repo: dir.startsWith(services.workspace.root) ? dir.slice(services.workspace.root.length + 1) || "root" : dir,
            ...(attempts > 1 ? { lockRetries: attempts - 1 } : {}),
            // Recorded only when false: a direct exec (not forked) pays a page-table copy, a real source of slowness.
            ...(forked ? {} : { forked: false }),
            ...(queueDepth > 0 ? { queueDepth } : {}),
        };
        services.perf.record("git.run", ms, { ...fields, execMs: Math.round(execMs) }, failed);
        // Filed as its own op so the summary separates git's own time from wait. Never negative: the two clocks are
        // read across an IPC hop, so a fast call can show a hair more exec time than wall time.
        services.perf.record("git.run.wait", Math.max(0, ms - execMs), fields, failed);
    });
};
