import { observeGitCommands, observeStaleLocks } from "@intentic/scaffold";
import { turnRunMetrics } from "../conversations/actor/conversation-holdings.js";
import { browserSessionMetrics } from "../browser/sessions/browser-sessions.js";
import { startResourceMetrics } from "../system/resources/resource-metrics.js";
import type { BootPhase } from "./boot-phase.js";

// Neither series reads back into the code it measures.
export const startDaemonMetrics = ({ config, logger, services, shutdown }: BootPhase): void => {
    const resourceMetrics = startResourceMetrics({
        historyRoot: config.historyRoot,
        logger,
        room: () => services.resources.snapshot(),
        owners: () => ({
            ...services.resourceOwners(),
            turnRuns: turnRunMetrics(services.conversations),
            browserSessions: browserSessionMetrics(),
            reaper: services.reaper.metrics(),
            invariants: { violations: services.invariants.violations().length },
        }),
    });
    shutdown.push(() => resourceMetrics.stop());

    // A lock git's own retry found stale and removed (scaffold git-locks.ts), said in the daemon's log, not the console.
    observeStaleLocks(({ path, ageMs }) =>
        logger.warn({ path, ageMinutes: Math.round(ageMs / 60_000) }, "git: removed a stale lock no git process held"),
    );

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
