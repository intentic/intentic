import { sweepAgedAgents } from "../agents/registry/archive.js";
import { capabilityCtx } from "../capabilities/capability.js";
import { unloadIdleLocalModels } from "../capabilities/handlers/localmodel.handler.js";
import { LOCAL_MODEL_IDLE_MS, LOCAL_MODEL_IDLE_SWEEP_MS } from "../endpoints/local-model-idle.js";
import { runGitMaintenance } from "../git/ops/maintenance.js";
import { logsRoot, pruneLogFiles } from "../logs/log-files.js";
import { panelKeyOf } from "../processes/managed-processes.js";
import { type ReapPolicy, reapFinishedSessions } from "../terminal/terminal-session.js";
import { pinTmuxServer, reportTmuxServerNamespace } from "../terminal/tmux-server.js";
import { sweepAgedState, sweepStateAtBoot } from "../workspace/watch/state-janitor.js";
import type { BootPhase } from "./boot-phase.js";

// Recurring passes over the daemon's own state: none gates anything, every one may fail, each is scoped by role.

const HOURLY_MS = 60 * 60 * 1000;

// Reads the registry through callbacks and takes per-repo locks, so a turn starting mid-walk is safe.
const sweepVanishedWorktrees = async ({ logger, services }: BootPhase): Promise<void> => {
    const vanished: string[] = [];
    for (const id of services.agents.ids()) {
        const entry = services.agents.entry(id);
        // Workspace conversations own no checkout; an archived entry is held by its commits, not a worktree.
        if (entry?.placement.kind !== "worktree" || entry.archivedAt !== undefined) {
            continue;
        }
        if (!(await services.agentWorktrees.exists(id))) {
            vanished.push(id);
        }
    }
    // Archived, never deleted: deletion stays where the user can see it.
    if (vanished.length > 0) {
        await services.agents.setArchived(vanished, Date.now());
        logger.info({ count: vanished.length }, "agents: archived entries whose worktree vanished");
    }
    // Membership is re-read per decision inside prune.
    const isolated = (id: string): boolean => services.agents.entry(id)?.placement.kind === "worktree";
    await services.agentWorktrees.prune(
        () => services.agents.ids().filter(isolated),
        () => services.agents.ids().filter((id) => isolated(id) && services.agents.entry(id)?.archivedAt !== undefined),
    );
};

// Directories no conversation row owns: a purge that deleted the rows and died before the directory, or a fork whose
// opening turn never began.
const sweepOrphanUnits = async ({ logger, services }: BootPhase): Promise<void> => {
    const swept = await services.conversationUnits.sweep(Date.now());
    if (swept.length > 0) {
        logger.info({ count: swept.length }, "conversations: swept directories no conversation owns");
        // Their records went with them, and with those the only names some blobs had.
        await services.transcripts.sweep(new Set());
    }
};

// agentRetentionDays 0 disables.
const sweepAgedArchive = ({ logger, services }: BootPhase): Promise<void> =>
    services.sandboxSettings
        .get()
        .then((settings) => sweepAgedAgents(services, Date.now(), settings.agentRetentionDays * 24 * 60 * 60 * 1000))
        .then(() => undefined)
        .catch((error: unknown) => logger.warn({ err: error }, "agents: archive sweep failed"));

// `keep`: a job still queued has only dead panes but isn't finished. agent-* sessions belong to the reaper.
const reapPolicyOf = ({ services }: BootPhase): ReapPolicy => ({
    keep: (session: string): boolean => services.terminalRun.running(session),
    finishedRunAt: (session: string): number | undefined => {
        const key = panelKeyOf(session);
        return key === undefined ? undefined : services.processes.runOf(key)?.finishedAt;
    },
});

const startRootSweeps = (phase: BootPhase): void => {
    const { config, logger, role, services, shutdown } = phase;
    if (!role.roots) {
        return;
    }
    void sweepVanishedWorktrees(phase).catch((error: unknown) => logger.warn({ err: error }, "agents: boot worktree sweep failed"));
    void sweepOrphanUnits(phase).catch((error: unknown) => logger.warn({ err: error }, "conversations: boot directory sweep failed"));
    void sweepAgedArchive(phase);
    setInterval(() => void sweepAgedArchive(phase), HOURLY_MS).unref();
    void sweepStateAtBoot(services.workspace.root, logger).catch((error: unknown) => logger.warn({ err: error }, "state janitor: boot sweep failed"));
    setInterval(
        () =>
            void sweepAgedState(services.workspace.root, Date.now(), logger).catch((error: unknown) =>
                logger.warn({ err: error }, "state janitor: aged sweep failed"),
            ),
        HOURLY_MS,
    ).unref();
    // Must run before any turn: panes inherit this daemon's mounts, and a pre-existing server can't be pinned later.
    void pinTmuxServer(logger).then(() => reportTmuxServerNamespace(logger));
    setInterval(() => void reportTmuxServerNamespace(logger), 15 * 60 * 1000).unref();
    // Never awaited: it exists to run while nothing waits.
    void runGitMaintenance(services.workspace, logger);
    setInterval(() => void runGitMaintenance(services.workspace, logger), HOURLY_MS).unref();
    // Root-scoped: a guest sharing the history root prunes nothing.
    const pruneLogs = (): Promise<void> =>
        pruneLogFiles(logsRoot(config.historyRoot)).catch((error: unknown) => logger.warn({ err: error }, "logs: the retention sweep failed"));
    void pruneLogs();
    const logsSweep = setInterval(() => void pruneLogs(), HOURLY_MS);
    shutdown.push(() => clearInterval(logsSweep));
};

const startContainerSweeps = (phase: BootPhase): void => {
    const { role, services, shutdown } = phase;
    if (!role.container) {
        return;
    }
    const reapPolicy = reapPolicyOf(phase);
    void reapFinishedSessions(reapPolicy);
    const sessionSweep = setInterval(() => void reapFinishedSessions(reapPolicy), HOURLY_MS);
    shutdown.push(() => clearInterval(sessionSweep));
    services.reaper.start();
    void services.reaper.sweep();
    // Armed whatever this boot started: a model server adopted from a previous daemon idles the same way.
    const modelCtx = capabilityCtx(services);
    const unloadIdle = setInterval(() => {
        void unloadIdleLocalModels(modelCtx, LOCAL_MODEL_IDLE_MS).catch((error: unknown) => {
            services.logger.warn({ err: error }, "localmodel idle sweep failed");
        });
    }, LOCAL_MODEL_IDLE_SWEEP_MS);
    // Must neither keep the daemon alive nor keep it from stopping.
    unloadIdle.unref();
    shutdown.push(() => clearInterval(unloadIdle));
};

// Root-scoped like the sweeps: a guest sharing the history root converts nothing.
const migrateRecords = ({ logger, role, services, shutdown }: BootPhase): Promise<void> => {
    if (!role.roots) {
        return Promise.resolve();
    }
    const stop = new AbortController();
    shutdown.push(() => stop.abort());
    return services.transcripts.migrate(stop.signal).catch((error: unknown) => logger.warn({ err: error }, "records: migration failed"));
};

export const startBootSweeps = (phase: BootPhase): void => {
    const { logger, services, shutdown } = phase;
    // Detached, so a check can't cause the outage it diagnoses; after the gate, which establishes the state checked.
    void services.invariants.run("boot");
    const invariantSweep = setInterval(() => void services.invariants.run("sweep"), 300_000);
    shutdown.push(() => clearInterval(invariantSweep));
    shutdown.push(services.events.subscribe("run.settled", () => services.invariants.run("turn-settled")));

    // Detached; routes report `indexing` meanwhile.
    const backfillSaid = (): void => {
        void services.saidIndex.backfill().catch((error: unknown) => logger.warn({ err: error }, "search index backfill failed"));
    };
    // After the migration, whose every conversion moves the size the index pins a record to.
    void migrateRecords(phase).then(backfillSaid);
    const saidSweep = setInterval(backfillSaid, 600_000);
    saidSweep.unref();
    shutdown.push(() => clearInterval(saidSweep));

    startRootSweeps(phase);
    startContainerSweeps(phase);
    // Registered whether or not this role started it, so every role unwinds cleanly.
    shutdown.push(() => services.reaper.stop());
};
