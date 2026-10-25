import { join } from "node:path";
import { panelKeyOf } from "@intentic/sandbox-contract/session-names";
import { dockerPruneChore } from "../capabilities/handlers/docker-prune.js";
import { parkedRefRetentionChore } from "../conversations/land/parked-ref-retention.js";
import { BUILD_OUTPUT_QUIET_MS, type PrunedAt, sweepAgedAgents, sweepBuildOutputs, sweepHeldCheckouts } from "../conversations/registry/archive.js";
import { runningJobsOf } from "../agent/tools/jobs/background-jobs.js";
import { deleteAgedConversations } from "../conversations/registry/transcript-retention.js";
import { cacheDirsOf, rawOutputDirsOf, type RetentionDeps, type RetentionKind, type RetentionPass, runRetentionSweep } from "../retention/retention-sweep.js";
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

// Persist housekeeping cadence in chore-clock.ts across restarts: git maintenance, storage/trash, dockerd and retention sweeps.
// Log results; heavy cleanup waits for no running turn and dockerd cleanup never starts an idle engine.
// Retention runs hourly (restore points daily) and after settings changes; all-zero settings disable data retention.
// Scratch belongs to boot-sweeps, agent-* sessions to the reaper; keep unfinished queued jobs even if all panes are dead.
const reapPolicyOf = ({ services }: BootPhase): ReapPolicy => ({
    keep: (session: string): boolean => services.terminalRun.running(session),
    finishedRunAt: (session: string): number | undefined => {
        const key = panelKeyOf(session);
        return key === undefined ? undefined : services.processes.runOf(key)?.finishedAt;
    },
});

// The tick interval: how soon a changed retention setting takes effect.
const RETENTION_SETTINGS_EVERY_MS = 5 * 60_000;

const retentionDepsOf = ({ config, logger, services }: BootPhase): RetentionDeps => ({
    settings: async () => (await services.sandboxSettings.get()).retention,
    now: Date.now,
    logger,
    transcripts: (now, maxAgeMs) => deleteAgedConversations(services, now, maxAgeMs),
    history: services.history,
    vault: services.privacyShield.vault,
    images: services.privacyShield.images,
    cacheDirs: async () => cacheDirsOf(services.workspace.root),
    rawOutputDirs: () => rawOutputDirsOf(config.historyRoot),
    // Every pass that ran goes on the audit trail: what kind, how far back, how many went, and the deleted
    // conversations' ids (never anything they said), so an office can show what retention erased and when.
    record: (pass) =>
        services.audit.record({
            actor: { kind: "system", reason: "retention sweep" },
            action: "retention.delete",
            target: pass.kind,
            details: retentionAuditDetails(pass),
        }),
});

// What a retention pass leaves on the audit trail: the window, the count, and the ids of deleted conversations. A type
// alias rather than an interface, since the record's details take any plain object.
type RetentionAuditDetails = { days: number; before: number; deleted: number; failed?: number; ids?: string[] };

const retentionAuditDetails = (pass: RetentionPass): RetentionAuditDetails => {
    const details: RetentionAuditDetails = { days: pass.days, before: pass.before, deleted: pass.deleted };
    if (pass.failed !== undefined) {
        details.failed = pass.failed;
    }
    if (pass.ids !== undefined && pass.ids.length > 0) {
        details.ids = [...pass.ids];
    }
    return details;
};

const dataRetentionChores = (phase: BootPhase): Chore[] => {
    const deps = retentionDepsOf(phase);
    const hourly: RetentionKind[] = ["transcripts", "privacyVault", "caches", "rawOutput"];
    // What the settings read last time; the first look only notes them, since the hourly and daily runs cover a boot.
    let seen: string | undefined;
    return [
        { name: "data-retention", everyMs: HOUR_MS, run: async () => void (await runRetentionSweep(deps, hourly)) },
        { name: "data-retention-restore-points", everyMs: DAY_MS, run: async () => void (await runRetentionSweep(deps, ["restorePoints"])) },
        {
            name: "data-retention-settings",
            everyMs: RETENTION_SETTINGS_EVERY_MS,
            run: async () => {
                const now = JSON.stringify(await deps.settings());
                const changed = seen !== undefined && seen !== now;
                seen = now;
                if (changed) {
                    await runRetentionSweep(deps);
                }
            },
        },
    ];
};

// Which quiet checkouts the build-output pass already emptied, for the daemon's life (archive.ts PrunedAt).
const buildOutputsPrunedAt: PrunedAt = new Map();

export const retentionChores = (phase: BootPhase): Chore[] => {
    const { config, logger, role, services } = phase;
    return [
        ...(role.roots ? dataRetentionChores(phase) : []),
        ...(role.roots
            ? [
                  {
                      name: "agents-aged-archive",
                      everyMs: HOUR_MS,
                      // agentRetentionDays 0 disables.
                      run: async (): Promise<void> => {
                          const { agentRetentionDays, heldCheckoutDays } = await services.sandboxSettings.get();
                          await sweepAgedAgents(services, Date.now(), agentRetentionDays * DAY_MS);
                          await sweepHeldCheckouts(services, Date.now(), heldCheckoutDays * DAY_MS, (id) => runningJobsOf(services.conversations, id).length);
                      },
                  },
                  {
                      name: "agents-build-outputs",
                      everyMs: HOUR_MS,
                      // Removing gigabytes is heavy disk work; it waits for a moment no turn is running.
                      when: () => services.conversations.liveSessionIds().length === 0,
                      run: async (): Promise<void> => {
                          await sweepBuildOutputs(
                              services,
                              Date.now(),
                              BUILD_OUTPUT_QUIET_MS,
                              (id) => runningJobsOf(services.conversations, id).length,
                              buildOutputsPrunedAt,
                          );
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
