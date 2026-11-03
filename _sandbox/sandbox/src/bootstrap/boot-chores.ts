import { join } from "node:path";
import { panelKeyOf } from "@intentic/sandbox-contract/session-names";
import { dockerPruneChore } from "../capabilities/handlers/docker-prune.js";
import { parkedRefRetentionChore } from "../conversations/land/parked-ref-retention.js";
import { quietOfSettings, sweepAgedAgents, sweepHeldCheckouts } from "../conversations/registry/archive.js";
import { cargoWarmRoot, retireAllWarmSnapshots } from "../conversations/worktrees/cargo-warm.js";
import { overlaysRoot } from "../conversations/worktrees/isolation.js";
import { type BuildOutputReaper, createBuildOutputReaper } from "../conversations/registry/build-output-sweep/build-output-reaper.js";
import { reapTmpCargoTargets } from "../conversations/worktrees/build-outputs/tmp-cargo-targets.js";
import { runningJobsOf } from "../agent/tools/jobs/background-jobs.js";
import { deleteAgedConversations } from "../conversations/registry/transcript-retention.js";
import { cacheDirsOf, rawOutputDirsOf, type RetentionDeps, type RetentionKind, type RetentionPass, runRetentionSweep } from "../retention/retention-sweep.js";
import { orphanCheckoutsChore } from "../conversations/worktrees/orphan-checkouts.js";
import { branchCheckoutsChore } from "../conversations/worktrees/branches/branch-checkouts.js";
import { liveBranchStarts } from "../conversations/land/branch/branch-repos.js";
import { gitGcChore } from "../git/ops/git-gc.js";
import { gitMaintenanceChore } from "../git/ops/maintenance.js";
import { clearStaleGitLocks, staleGitLocksChore } from "../git/ops/stale-git-locks.js";
import { logsRoot, pruneLogFiles } from "../logs/log-files.js";
import { type Chore, DAY_MS, HOUR_MS, startChoreClock } from "../system/chore-clock.js";
import { trashSweepChore } from "../system/resources/storage/trash-sweep.js";
import { readHistorySpace } from "../system/resources/storage/checkout-admission.js";
import { startDiskPressureWatch } from "../system/resources/storage/disk-pressure.js";
import { readLastStorageScan } from "../system/resources/storage/disk-storage.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { diskLow } from "../push/notifications.js";
import { type ReapPolicy, reapFinishedSessions } from "../terminal/terminal-session.js";
import { sweepAgedState } from "../workspace/watch/state-janitor.js";
import type { BootPhase } from "./boot-phase.js";

// Persist housekeeping cadence in chore-clock.ts across restarts: git maintenance, storage/trash, dockerd and retention sweeps.
// Log results; git upkeep waits for no running turn, build output is swept per checkout (archive.ts) and dockerd cleanup never starts an idle engine.
// Retention runs hourly (restore points daily) and after settings changes; all-zero settings disable data retention.
// Scratch belongs to boot-sweeps, agent-* sessions to the reaper; keep unfinished queued jobs even if all panes are dead.
const reapPolicyOf = ({ services }: BootPhase): ReapPolicy => ({
    keep: (session: string): boolean => services.terminalRun.running(session),
    finishedRunAt: (session: string): number | undefined => {
        const key = panelKeyOf(session);
        return key === undefined ? undefined : services.processes.runOf(key)?.finishedAt;
    },
});

const BUILD_OUTPUT_SWEEP_MS = 15 * 60_000;

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

// One reaper per daemon, so the sweep and the disk-pressure watch share its memory of what is already emptied.
let reaper: BuildOutputReaper | undefined;
const reaperOf = ({ config, services }: BootPhase): BuildOutputReaper =>
    (reaper ??= createBuildOutputReaper({
        archive: services,
        worktreesRoot: join(config.historyRoot, "worktrees"),
        overlaysRoot: overlaysRoot(config.historyRoot),
        runningJobs: (id) => runningJobsOf(services.conversations, id).length,
        quiet: async () => quietOfSettings((await services.sandboxSettings.get()).buildOutputIdleHours),
    }));

// A pass that freed checkouts' shared-Cargo layers unpinned the snapshots they read; the unused ones go now rather than
// at the next turn's setup (cargo-warm.ts retireAllWarmSnapshots). Nothing to do where no snapshot was ever made.
const retireUnpinned = async ({ config, logger }: BootPhase, swept: number): Promise<void> => {
    if (swept === 0) {
        return;
    }
    const retired = await retireAllWarmSnapshots({ store: cargoWarmRoot(config.historyRoot), overlays: overlaysRoot(config.historyRoot), now: Date.now() });
    if (retired.length > 0) {
        logger.info({ retired: retired.length }, "storage: retired shared Cargo snapshots no checkout reads any more");
    }
};

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
                      // Often enough that a landed checkout's output goes about an hour after the land.
                      everyMs: BUILD_OUTPUT_SWEEP_MS,
                      // No sandbox-wide quiet moment: each checkout is judged by its own conversation (archive.ts).
                      run: async (): Promise<void> => retireUnpinned(phase, (await reaperOf(phase).sweep(Date.now())).length),
                  },
                  { name: "state-aged", everyMs: HOUR_MS, run: () => sweepAgedState(services.workspace.root, Date.now(), logger) },
                  // Root-scoped: a guest sharing the history root prunes nothing.
                  { name: "log-retention", everyMs: HOUR_MS, run: () => pruneLogFiles(logsRoot(config.historyRoot)) },
              ]
            : []),
        ...(role.container
            ? [
                  { name: "finished-terminal-sessions", everyMs: HOUR_MS, run: () => reapFinishedSessions(reapPolicyOf(phase)) },
                  // Cargo targets agents pointed into the container's /tmp, which no checkout sweep sees.
                  { name: "tmp-cargo-targets", everyMs: HOUR_MS, run: async () => void (await reapTmpCargoTargets({ root: "/tmp", now: Date.now(), logger })) },
              ]
            : []),
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
                  branchCheckoutsChore({ branchCheckouts: services.branchCheckouts, targeted: () => liveBranchStarts(services.agents), logger }),
              ]
            : []),
        ...(role.container ? [dockerPruneChore({ processes: services.processes, conversations: services.conversations, logger })] : []),
    ];
};

// The history volume looked at once a minute; short of room, settled checkouts' build output goes and the owner is told
// (system/resources/storage/disk-pressure.ts).
const startDiskPressure = (phase: BootPhase): (() => void) => {
    const { config, logger, services } = phase;
    const read = () => readHistorySpace(config.historyRoot);
    return startDiskPressureWatch({
        read,
        reapBelow: async () => (await services.sandboxSettings.get()).diskReapBelowPercent / 100,
        reap: async (enough) => {
            const swept = (await reaperOf(phase).reapUnderPressure(Date.now(), enough)).length;
            await retireUnpinned(phase, swept);
            return swept;
        },
        lastScan: () => readLastStorageScan(config.historyRoot),
        tell: async (level, state) => {
            const notice = diskLow(level, state);
            await (level === "critical" ? services.pushSender.notify(notice) : services.pushSender.notifyIfAway(notice));
        },
        changed: () => publishRuntimeChange("disk"),
        logger,
        now: Date.now,
    });
};

export const startHousekeeping = (phase: BootPhase): void => {
    const { config, logger, role, shutdown } = phase;
    // A lock a killed git left blocks every later git, maintenance included, so it goes before the first chore runs;
    // only with no git process running (git/ops/stale-git-locks.ts).
    if (role.roots) {
        void clearStaleGitLocks(config.historyRoot, logger);
    }
    if (role.roots && config.historyRoot !== "") {
        shutdown.push(startDiskPressure(phase));
    }
    const chores = choresOf(phase);
    if (chores.length === 0 || config.historyRoot === "") {
        return;
    }
    const clock = startChoreClock({ historyRoot: config.historyRoot, logger }, chores);
    shutdown.push(clock.stop);
};
