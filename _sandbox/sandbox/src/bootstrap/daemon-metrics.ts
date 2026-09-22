import { observeGitCommands } from "@intentic/scaffold";
import { turnRunMetrics } from "../agent/run/turn/turn-runs.js";
import { browserSessionMetrics } from "../browser/sessions/browser-sessions.js";
import { startResourceMetrics } from "../platform/resources/resource-metrics.js";
import type { BootPhase } from "./boot-phase.js";

// Neither series reads back into the code it measures.
export const startDaemonMetrics = ({ config, logger, services, shutdown }: BootPhase): void => {
    const resourceMetrics = startResourceMetrics({
        historyRoot: config.historyRoot,
        logger,
        owners: () => ({
            ...services.resourceOwners(),
            turnRuns: turnRunMetrics(),
            browserSessions: browserSessionMetrics(),
            reaper: services.reaper.metrics(),
            invariants: { violations: services.invariants.violations().length },
        }),
    });
    shutdown.push(() => resourceMetrics.stop());

    // `args` keeps the subcommand and drops trailing pathspecs, which can be hundreds.
    observeGitCommands(({ dir, args, ms, execMs, attempts, failed, forked, queueDepth }) => {
        const fields = {
            git: args.slice(0, 3).join(" "),
            repo: dir.startsWith(services.workspace.root) ? dir.slice(services.workspace.root.length + 1) || "root" : dir,
            ...(attempts > 1 ? { lockRetries: attempts - 1 } : {}),
            // Recorded only when false: a direct exec pays a page-table copy.
            ...(forked ? {} : { forked: false }),
            ...(queueDepth > 0 ? { queueDepth } : {}),
        };
        services.perf.record("git.run", ms, { ...fields, execMs: Math.round(execMs) }, failed);
        // Never negative: the two clocks are read across an IPC hop.
        services.perf.record("git.run.wait", Math.max(0, ms - execMs), fields, failed);
    });
};
