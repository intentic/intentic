import { join } from "node:path";
import { panelKeyOf } from "@intentic/sandbox-contract/session-names";
import { dockerPruneChore } from "../capabilities/handlers/docker-prune.js";
import { parkedRefRetentionChore } from "../conversations/land/parked-ref-retention.js";
import { sweepAgedAgents } from "../conversations/registry/archive.js";
import { orphanCheckoutsChore } from "../conversations/worktrees/orphan-checkouts.js";
import { gitGcChore } from "../git/ops/git-gc.js";
import { gitMaintenanceChore } from "../git/ops/maintenance.js";
import { clearStaleGitLocks, staleGitLocksChore } from "../git/ops/stale-git-locks.js";
import { logsRoot, pruneLogFiles } from "../logs/log-files.js";
import { type Chore, DAY_MS, HOUR_MS, startChoreClock } from "../system/chore-clock.js";
import { trashSweepChore } from "../system/resources/storage/trash-sweep.js";
import { type ReapPolicy, reapFinishedSessions } from "../terminal/terminal-session.js";
import { sweepAgedState } from "../workspace/watch/state-janitor.js";
import type { BootPhase } from "./boot-phase.js";

// THE SANDBOX'S HOUSEKEEPING (2026-10-05), on one clock that remembers across restarts when each chore last ran
// (system/chore-clock.ts): what /history and the agents' Docker engine gather and nothing else ever removes. Each chore
// logs what it did; the heavy ones wait for a moment with no turn running.
// - git: maintenance hourly (it was a timer reset by every restart), stale locks hourly while idle, `gc` with two weeks'
//   grace daily while idle, and the parked branches of conversations archived over 90 days ago daily;
// - storage: /history/trash entries past 14 days hourly, checkouts and dependency overlays no conversation owns daily;
// - the agents' dockerd, when it already runs: stopped containers and dangling images daily;
// - retention passes (2026-10-12), hourly: agents archived once finished past the retention window, the aged browser
//   captures and the file view's trash, the log files over their keeping, and finished terminal sessions. None must also
//   run at every boot (each ages things out by the hour), so the clock needs no run-at-boot option for them; the scratch
//   emptied at boot is a boot step, not a chore (boot-sweeps.ts).
// `keep`: a job still queued has only dead panes but isn't finished. agent-* sessions belong to the reaper.
const reapPolicyOf = ({ services }: BootPhase): ReapPolicy => ({
    keep: (session: string): boolean => services.terminalRun.running(session),
    finishedRunAt: (session: string): number | undefined => {
        const key = panelKeyOf(session);
        return key === undefined ? undefined : services.processes.runOf(key)?.finishedAt;
    },
});

export const retentionChores = (phase: BootPhase): Chore[] => {
    const { config, logger, role, services } = phase;
    return [
        ...(role.roots
            ? [
                  {
                      name: "agents-aged-archive",
                      everyMs: HOUR_MS,
                      // agentRetentionDays 0 disables.
                      run: async (): Promise<void> => {
                          const { agentRetentionDays } = await services.sandboxSettings.get();
                          await sweepAgedAgents(services, Date.now(), agentRetentionDays * DAY_MS);
                      },
                  },
                  { name: "state-aged", everyMs: HOUR_MS, run: () => sweepAgedState(services.workspace.root, Date.now(), logger) },
                  // Root-scoped: a guest sharing the history root prunes nothing.
                  { name: "log-retention", everyMs: HOUR_MS, run: () => pruneLogFiles(logsRoot(config.historyRoot)) },
              ]
            : []),
        ...(role.container ? [{ name: "finished-terminal-sessions", everyMs: HOUR_MS, run: () => reapFinishedSessions(reapPolicyOf(phase)) }] : []),
    ];
};

const choresOf = (phase: BootPhase): Chore[] => {
    const { config, logger, role, services } = phase;
    return [
        ...retentionChores(phase),
        ...(role.roots
            ? [
                  gitMaintenanceChore({ workspace: services.workspace, logger }),
                  staleGitLocksChore({ historyRoot: config.historyRoot, logger, conversations: services.conversations }),
                  gitGcChore({ workspace: services.workspace, logger, conversations: services.conversations }),
                  parkedRefRetentionChore({
                      workspace: services.workspace,
                      agents: services.agents,
                      agentWorktrees: services.agentWorktrees,
                      conversations: services.conversations,
                      logger,
                  }),
                  trashSweepChore({ historyRoot: config.historyRoot, units: services.conversationUnits, transcripts: services.transcripts, logger }),
                  orphanCheckoutsChore({
                      historyRoot: config.historyRoot,
                      worktreesRoot: join(config.historyRoot, "worktrees"),
                      registry: services.agents,
                      owners: services.conversationUnits.owners,
                      logger,
                  }),
              ]
            : []),
        ...(role.container ? [dockerPruneChore({ processes: services.processes, conversations: services.conversations, logger })] : []),
    ];
};

export const startHousekeeping = (phase: BootPhase): void => {
    const { config, logger, role, shutdown } = phase;
    // A lock a killed git left blocks every later git, maintenance included, so it goes before the first chore runs;
    // only with no git process running (git/ops/stale-git-locks.ts).
    if (role.roots) {
        void clearStaleGitLocks(config.historyRoot, logger);
    }
    const chores = choresOf(phase);
    if (chores.length === 0 || config.historyRoot === "") {
        return;
    }
    const clock = startChoreClock({ historyRoot: config.historyRoot, logger }, chores);
    shutdown.push(clock.stop);
};
