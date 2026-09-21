import { onTurnSettled } from "../agent/run/turn/turn-runs.js";
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

// The recurring passes this daemon makes over its own state: each runs once as boot ends, then on its own timer. None
// of them gates anything, every one is allowed to fail, and each is scoped by the role this daemon claimed.

const HOURLY_MS = 60 * 60 * 1000;

// Archives entries whose checkout vanished, prunes orphaned dirs, parks off-board branches. Reads the registry through
// callbacks and takes per-repo locks, so a turn starting mid-walk is safe.
const sweepVanishedWorktrees = async ({ logger, services }: BootPhase): Promise<void> => {
    const vanished: string[] = [];
    for (const id of services.agents.ids()) {
        const entry = services.agents.entry(id);
        // Workspace conversations own no checkout by design; missing on disk doesn't mean vanished here. An archived
        // entry has no worktree by design (reclaimed); it is held by its commits, not this check.
        if (entry?.branch === undefined || entry.archivedAt !== undefined) {
            continue;
        }
        if (!(await services.agentWorktrees.exists(id))) {
            vanished.push(id);
        }
    }
    // A live entry with no checkout becomes archived, held by its branch; deletion stays where the user can see it
    // (discard, or the archive's own purge).
    if (vanished.length > 0) {
        await services.agents.setArchived(vanished, Date.now());
        logger.info({ count: vanished.length }, "agents: archived entries whose worktree vanished");
    }
    // Membership is re-read per decision inside prune, so a conversation opened mid-sweep isn't judged by this
    // snapshot.
    await services.agentWorktrees.prune(
        () => services.agents.ids().filter((id) => services.agents.entry(id)?.branch !== undefined),
        () =>
            services.agents
                .ids()
                .filter((id) => services.agents.entry(id)?.branch !== undefined && services.agents.entry(id)?.archivedAt !== undefined),
    );
};

// Archives Finished agents past the retention window (agentRetentionDays; 0 disables) so the lane doesn't become a
// permanent record. Losslessly (agents/registry/archive.ts).
const sweepAgedArchive = ({ logger, services }: BootPhase): Promise<void> =>
    services.sandboxSettings
        .get()
        .then((settings) => sweepAgedAgents(services, Date.now(), settings.agentRetentionDays * 24 * 60 * 60 * 1000))
        .then(() => undefined)
        .catch((error: unknown) => logger.warn({ err: error }, "agents: archive sweep failed"));

// Reaps abandoned web-* shells, finished job-* sessions and the shells one-shot runs leave at a prompt. `keep` makes
// this safe unattended: a job still queued has only dead panes but isn't finished. agent-* belongs to the reaper.
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
    void sweepAgedArchive(phase);
    setInterval(() => void sweepAgedArchive(phase), HOURLY_MS).unref();
    // State dir's own garbage (scratch, retired derived roots, aged captures); same cadence and ownership guard as the
    // agent sweeps above.
    void sweepStateAtBoot(services.workspace.root, logger).catch((error: unknown) => logger.warn({ err: error }, "state janitor: boot sweep failed"));
    setInterval(
        () =>
            void sweepAgedState(services.workspace.root, Date.now(), logger).catch((error: unknown) =>
                logger.warn({ err: error }, "state janitor: aged sweep failed"),
            ),
        HOURLY_MS,
    ).unref();
    // Forks the tmux server here so every pane inherits this daemon's mounts, not a conversation's private /work; must
    // happen before any turn runs. Rechecked on a slow loop; a pre-existing server can't be pinned after the fact.
    void pinTmuxServer(logger).then(() => reportTmuxServerNamespace(logger));
    setInterval(() => void reportTmuxServerNamespace(logger), 15 * 60 * 1000).unref();
    // Packs refs and loose objects, keeps the commit-graph current. Never awaited: its whole point is to run while
    // nothing is waiting, so a repo mid-relocation is simply maintained an hour later.
    void runGitMaintenance(services.workspace, logger);
    setInterval(() => void runGitMaintenance(services.workspace, logger), HOURLY_MS).unref();
    // Root-scoped: these are the logs of whoever owns this history root, and a guest sharing it prunes nothing.
    void pruneLogFiles(logsRoot(config.historyRoot));
    const logsSweep = setInterval(() => void pruneLogFiles(logsRoot(config.historyRoot)), HOURLY_MS);
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
    // Reclaims everything a stopped conversation still holds: its provider CLI tree, MCP servers and browsers, its
    // agent-* sessions, browser records, temp state, on its own stop clock.
    services.reaper.start();
    void services.reaper.sweep();
    // A loaded model holds its weights and its whole KV cache whether or not anything is using it, which is the
    // largest resident thing in a quiet sandbox. One nobody has generated a token with in half an hour gives it
    // back; the turn that asks for it next waits out a reload, which harness-credentials does on its behalf. Armed
    // whatever this boot started: a model server adopted from a previous daemon idles the same way.
    const modelCtx = capabilityCtx(services);
    const unloadIdle = setInterval(() => {
        void unloadIdleLocalModels(modelCtx, LOCAL_MODEL_IDLE_MS).catch((error: unknown) => {
            services.logger.warn({ err: error }, "localmodel idle sweep failed");
        });
    }, LOCAL_MODEL_IDLE_SWEEP_MS);
    // Reclaiming memory must be neither what keeps the daemon alive nor what keeps it from stopping.
    unloadIdle.unref();
    shutdown.push(() => clearInterval(unloadIdle));
};

export const startBootSweeps = (phase: BootPhase): void => {
    const { logger, services, shutdown } = phase;
    // Invariant checks are driven from boot since boot knows the moments. Detached, so a check can't cause the outage
    // it diagnoses; run after the gate, since the boot steps establish the state being checked.
    void services.invariants.run("boot");
    const invariantSweep = setInterval(() => void services.invariants.run("sweep"), 300_000);
    shutdown.push(() => clearInterval(invariantSweep));
    shutdown.push(onTurnSettled(() => void services.invariants.run("turn-settled")));

    // Backfills the search index after the gate: turns write it forward in steady state, so this matters only on first
    // run, a schema bump, or downtime. Detached; routes report `indexing` meanwhile.
    const backfillSaid = (): void => {
        void services.saidIndex.backfill().catch((error: unknown) => logger.warn({ err: error }, "search index backfill failed"));
    };
    backfillSaid();
    const saidSweep = setInterval(backfillSaid, 600_000);
    saidSweep.unref();
    shutdown.push(() => clearInterval(saidSweep));

    startRootSweeps(phase);
    startContainerSweeps(phase);
    // The conversation reaper's own stop is registered whether or not this role starts it, so a role that never swept
    // still unwinds cleanly.
    shutdown.push(() => services.reaper.stop());
};
