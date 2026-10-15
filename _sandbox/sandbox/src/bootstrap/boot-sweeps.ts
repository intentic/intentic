import { startPeriodic } from "@intentic/base/async";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import { archiveVanishedWorktrees } from "../conversations/registry/vanished-worktrees.js";
import { capabilityCtx } from "../capabilities/capability.js";
import { unloadIdleLocalModels } from "../capabilities/handlers/localmodel.handler.js";
import { LOCAL_MODEL_IDLE_MS, LOCAL_MODEL_IDLE_SWEEP_MS } from "../endpoints/local-model-idle.js";
import { startWindowsRevival } from "../hosts/environment-bootstrap.js";
import { stopCursorRuntimes } from "../runtimes/cursor/cursor-host.js";
import { QUARANTINE_MS, quarantineRoot } from "../store/conversation-units.js";
import { createRepeatGate } from "../logs/repeat-gate.js";
import { pinTmuxServer, reportTmuxServerNamespace } from "../terminal/tmux-server.js";
import { DAY_MS } from "../system/chore-clock.js";
import { sweepStateAtBoot } from "../workspace/watch/state-janitor.js";
import type { BootPhase } from "./boot-phase.js";
import { startHousekeeping } from "./boot-chores.js";

// Recurring passes over the daemon's own state: none gates anything, every one may fail, each is scoped by role.
//
// ONE CLOCK FOR HOUSEKEEPING (2026-10-12). Whatever runs hourly or slower is a chore on the persistent clock
// (boot-chores.ts, system/chore-clock.ts), which remembers across restarts when each last ran: the aged-agent archive, the
// aged state sweep, the log retention and the finished-terminal reap, which used to run at every boot and then on a raw
// hourly timer, so a sandbox restarting more often than hourly ran them all each time. What stays here either runs once
// per boot (the scratch and orphan sweeps) or is a minutes-scale watch rather than housekeeping, on `startPeriodic` (which
// never overlaps its runs and unrefs its timers); a raw `setInterval` is not used for either.

// Archives what lost its checkout for good, then prunes worktree admin and parks off-board branches.
const sweepVanishedWorktrees = async ({ services }: BootPhase): Promise<void> => {
    await archiveVanishedWorktrees(services, Date.now());
    // Membership is re-read per decision inside prune.
    const isolated = (id: string): boolean => services.agents.entry(id)?.placement.kind === "worktree";
    await services.agentWorktrees.prune(
        () => services.agents.ids().filter(isolated),
        () => services.agents.ids().filter((id) => isolated(id) && services.agents.entry(id)?.archivedAt !== undefined),
    );
};

// Directories no conversation row owns: a purge that deleted the rows and died before the directory, or a fork whose
// opening turn never began. Moved aside rather than deleted, and removed for good only QUARANTINE_MS later
// (store/conversation-units.ts); held altogether while the database cannot be trusted to name every conversation.
const sweepOrphanUnits = async ({ logger, services }: BootPhase): Promise<void> => {
    const swept = await services.conversationUnits.sweep(Date.now());
    if (swept.held === "database-recreated") {
        logger.warn("conversations: the database was made again this boot, so no conversation's directory is taken for an orphan");
        return;
    }
    if (swept.held === "database-empty") {
        logger.warn("conversations: the database holds no conversation while conversation directories remain, so none is taken for an orphan");
        return;
    }
    if (swept.quarantined.length > 0) {
        logger.info(
            { count: swept.quarantined.length, ids: swept.quarantined, to: quarantineRoot(services.config.historyRoot), keptDays: QUARANTINE_MS / DAY_MS },
            "conversations: moved directories no conversation owns aside, where they are kept before being removed",
        );
    }
    if (swept.pruned.length > 0) {
        logger.info({ count: swept.pruned.length }, "conversations: removed directories set aside past their keeping");
        // Their records went with them, and with those the only names some blobs had.
        await services.transcripts.sweep(new Set());
    }
};

const startRootSweeps = (phase: BootPhase): void => {
    const { logger, role, services, shutdown } = phase;
    if (!role.roots) {
        return;
    }
    void sweepVanishedWorktrees(phase).catch((error: unknown) => logger.warn({ err: error }, "agents: boot worktree sweep failed"));
    void sweepOrphanUnits(phase).catch((error: unknown) => logger.warn({ err: error }, "conversations: boot directory sweep failed"));
    void sweepStateAtBoot(services.workspace.root, logger).catch((error: unknown) => logger.warn({ err: error }, "state janitor: boot sweep failed"));
    // Must run before any turn: panes inherit this daemon's mounts, and a pre-existing server can't be pinned later. The
    // owner's ssh agent socket only where the tmux server is the container's: a daemon on someone's own machine shares
    // their tmux, and their own agent is theirs.
    const serverEnv = role.container ? { SSH_AUTH_SOCK: services.sshAgent.owner } : {};
    void pinTmuxServer(logger, serverEnv).then(() => reportTmuxServerNamespace(logger));
    // A minutes-scale diagnosis of a server that outlives this daemon, not housekeeping, so not a chore: it has to keep
    // watching while the sandbox is busy. The first look is the one above, as the server is pinned.
    shutdown.add(
        startPeriodic({
            everyMs: 15 * 60 * 1000,
            run: () => reportTmuxServerNamespace(logger),
            onError: (error) => logger.warn({ err: error }, "tmux: the namespace report failed"),
        }),
    );
};

// The idle sweep runs every minute, so a failure it keeps meeting wrote its stack every minute. A process that left
// between the scan and the read (ESRCH) is what the sweep is there to notice, not a failure, and anything else is
// written when what it fails with changes, then hourly, and once more when a pass goes through.
export const idleSweepLog = (logger: Pick<Logger, "debug" | "info" | "warn">, now?: () => number) => {
    const gate = createRepeatGate(now === undefined ? {} : { now });
    return {
        failed: (error: unknown): void => {
            if (errnoCode(error) === "ESRCH") {
                logger.debug({ reason: errorMessage(error) }, "localmodel idle sweep: a server left mid-sweep");
                return;
            }
            const verdict = gate.check("sweep", errnoCode(error) ?? errorMessage(error));
            if (verdict.log) {
                logger.warn({ err: error, ...(verdict.repeated > 0 ? { repeated: verdict.repeated } : {}) }, "localmodel idle sweep failed");
            }
        },
        succeeded: (): void => {
            const outage = gate.clear("sweep");
            if (outage !== undefined) {
                logger.info({ after: outage.state, repeated: outage.repeated }, "localmodel idle sweep works again");
            }
        },
    };
};

const startContainerSweeps = (phase: BootPhase): void => {
    const { role, services, shutdown } = phase;
    if (!role.container) {
        return;
    }
    services.reaper.start();
    void services.reaper.sweep();
    // Armed whatever this boot started: a model server adopted from a previous daemon idles the same way. Every minute,
    // because an idle model gives back its memory within minutes: a clock that looks hourly would hold it for hours.
    const modelCtx = capabilityCtx(services);
    const sweepLog = idleSweepLog(services.logger);
    shutdown.add(
        startPeriodic({
            everyMs: LOCAL_MODEL_IDLE_SWEEP_MS,
            run: () => unloadIdleLocalModels(modelCtx, LOCAL_MODEL_IDLE_MS).then(sweepLog.succeeded, sweepLog.failed),
        }),
    );
    // A PC's Windows side can drop while its WSL distro stays connected, which no connect event says; a minutes-scale
    // look puts it back through the distro (hosts/environment-bootstrap.ts, 2026-10-15).
    shutdown.add(startWindowsRevival(services));
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
    // Minutes-scale, and a check of what is true now rather than housekeeping, so on its own short loop and not a chore.
    shutdown.add(
        startPeriodic({
            everyMs: 300_000,
            run: async () => {
                await services.invariants.run("sweep");
            },
            onError: (error) => logger.warn({ err: error }, "invariants: the sweep could not run"),
        }),
    );
    shutdown.push(services.events.subscribe("run.settled", () => services.invariants.run("turn-settled")));

    // Detached; routes report `indexing` meanwhile.
    const backfillSaid = (): void => {
        void services.saidIndex.backfill().catch((error: unknown) => logger.warn({ err: error }, "search index backfill failed"));
    };
    // After the migration, whose every conversion moves the size the index pins a record to.
    void migrateRecords(phase).then(backfillSaid);
    // Every ten minutes, so a record that grew between presses is searchable within one: a minutes-scale catch-up, not a chore.
    shutdown.add(startPeriodic({ everyMs: 600_000, run: backfillSaid }));

    startRootSweeps(phase);
    startContainerSweeps(phase);
    // The hourly-and-slower passes, and git maintenance among them, once an hour across restarts rather than at every boot.
    startHousekeeping(phase);
    // Registered whether or not this role started it, so every role unwinds cleanly.
    shutdown.push(() => services.reaper.stop());
    // Turns' mounts: their browsers are this daemon's children, and a restart must not leave them driving pages nobody
    // can reach; no bearer minted by this boot answers once it is winding down.
    shutdown.push(() => services.turnMounts.closeAll());
    // The shared `opencode serve` and the Cursor runtime processes are this daemon's children too, and outlived a clean
    // stop before 2026-10-05 (the next boot's generation sweep is the backstop for an unclean one).
    // allow(silent-catch): this runs as the daemon exits; a server that would not stop is left to that generation sweep.
    shutdown.push(() => void services.openCode.stop().catch(() => undefined));
    shutdown.push(stopCursorRuntimes);
};
