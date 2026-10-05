import { join } from "node:path";
import { dockerPruneChore } from "../capabilities/handlers/docker-prune.js";
import { parkedRefRetentionChore } from "../conversations/land/parked-ref-retention.js";
import { orphanCheckoutsChore } from "../conversations/worktrees/orphan-checkouts.js";
import { gitGcChore } from "../git/ops/git-gc.js";
import { gitMaintenanceChore } from "../git/ops/maintenance.js";
import { clearStaleGitLocks, staleGitLocksChore } from "../git/ops/stale-git-locks.js";
import { type Chore, startChoreClock } from "../system/chore-clock.js";
import { trashSweepChore } from "../system/resources/storage/trash-sweep.js";
import type { BootPhase } from "./boot-phase.js";

// THE SANDBOX'S HOUSEKEEPING (2026-10-05), on one clock that remembers across restarts when each chore last ran
// (system/chore-clock.ts): what /history and the agents' Docker engine gather and nothing else ever removes. Each chore
// logs what it did; the heavy ones wait for a moment with no turn running.
// - git: maintenance hourly (it was a timer reset by every restart), stale locks hourly while idle, `gc` with two weeks'
//   grace daily while idle, and the parked branches of conversations archived over 90 days ago daily;
// - storage: /history/trash entries past 14 days hourly, checkouts and dependency overlays no conversation owns daily;
// - the agents' dockerd, when it already runs: stopped containers and dangling images daily.
const choresOf = ({ config, logger, role, services }: BootPhase): Chore[] => [
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
