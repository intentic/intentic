import type { PrismaClient } from "@intentic/prisma";
import { ORPCError } from "@orpc/server";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { decryptSecret } from "../../../crypto.js";
import { holdExclusive, JOB_SLEEP_WATCH } from "../../../jobs-lock.js";
import { hostedEnabled } from "../hosted.js";
import { claimRequestStart, findRequestWakeSandbox } from "../wake/hosted-request-wake.js";
import { FINAL_REFUSALS, HOSTED_WAKE_BOOT_MS } from "../wake/hosted-wake-alarm.js";
import { type HostedWakeContext, wakeHostedSandbox } from "../wake/hosted-wake.js";
import { type DiscordWatch, type DiscordWatchHooks, watchDiscord } from "./discord-watch.js";
import { recordSleepHeard, SLEEP_WATCHES_PER_ACCOUNT } from "./sleep-watch.js";

/* THE SLEEP WATCHER (2026-11-27): holds a gateway connection for every bot a sleeping hosted sandbox's owner let the
 * platform hold (sleep-watch.ts), and starts the machine when one hears a message for its bot.
 *
 * One replica runs it, under the exclusive-job lock held for as long as it runs (jobs-lock.ts `holdExclusive`); a replica
 * that loses the lock's connection closes every socket, and another takes it within a tick. Every few seconds it reads
 * the holds that are due (past their settle time, on a sandbox still hosted and not removed), opens a connection for
 * each new one and closes the ones whose hold is gone, so a hold the waking daemon deleted is let go within a pass.
 *
 * A message heard is recorded (where it is, never what it says) and the machine is started through the request wake's
 * claim (hosted-request-wake.ts `claimRequestStart`): the alarm's own start (standing, spent hours, the state gate,
 * metering, never counted as a person), one start while one boots, at most the day's request starts. Once started, the
 * connection stays, recording what else arrives while the machine boots and starting nothing more, until the daemon's
 * first word deletes the hold, or a boot's time passes without one. A start refused for good (standing, hours, a machine
 * that is gone) drops the sandbox's holds; one that stumbled is tried again with backoff; one past the day's cap waits
 * for the next UTC day. Bounded: SLEEP_WATCH_SOCKETS_MAX connections in all, SLEEP_WATCHES_PER_ACCOUNT per account. */

const SLEEP_WATCH_SYNC_MS = 5_000;
const SLEEP_WATCH_SOCKETS_MAX = 256;
// What was heard is kept at most this long for a gateway that never asked.
const SLEEP_HEARD_KEEP_MS = 7 * 24 * 3_600_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_CEILING_MS = 30 * 60_000;

// What starting a sandbox for a heard message came to: begun (settling with what stopped it), one already booting, the
// day's starts spent, or a sandbox no longer there to start.
export type WatchStart =
    | { readonly kind: "started"; readonly settled: Promise<Error | undefined> }
    | { readonly kind: "booting" | "spent" | "gone" };

export interface SleepWatcherDeps {
    readonly prisma: PrismaClient;
    readonly config: Config;
    readonly logger: Logger;
    readonly watch?: (token: string, hooks: DiscordWatchHooks) => DiscordWatch;
    readonly start?: (sandboxId: string, now: Date) => Promise<WatchStart>;
    readonly now?: () => Date;
}

/** The production start: the request wake's claim (and through it the alarm's own start, never as a person), as a
 * message a watch heard. */
export const requestStart =
    (context: HostedWakeContext, wake: typeof wakeHostedSandbox = wakeHostedSandbox) =>
    async (sandboxId: string, now: Date): Promise<WatchStart> => {
        const sandbox = await findRequestWakeSandbox(context.prisma, { id: sandboxId });
        if (sandbox === null || sandbox.hosted === null) {
            return { kind: "gone" };
        }
        const claimed = await claimRequestStart(context, { ...sandbox, hosted: sandbox.hosted }, now, "a Discord message a sleep watch heard", wake);
        return claimed.kind === "started" ? { kind: "started", settled: claimed.started } : { kind: claimed.kind };
    };

const nextUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
const retryDelayMs = (failures: number): number => Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** failures);

interface Held {
    readonly id: string;
    readonly sandboxId: string;
    readonly service: string;
    readonly connection: string;
    readonly watch: DiscordWatch;
}

export interface SleepWatcher {
    // One pass: forget what is stale, open and close connections, start a sandbox whose watch heard something.
    readonly sync: () => Promise<void>;
    // The connections open now, by hold id.
    readonly open: () => readonly string[];
    readonly closeAll: () => void;
}

// Forgets what nobody will act on: holds of a sandbox removed or no longer hosted, holds a start left past a boot's time,
// and what was heard a week ago.
const pruneStale = async (prisma: PrismaClient, at: Date): Promise<void> => {
    await prisma.sleepWatch.deleteMany({ where: { OR: [{ sandbox: { removedAt: { not: null } } }, { sandbox: { hosted: null } }] } });
    await prisma.sleepWatch.deleteMany({ where: { wokeAt: { lt: new Date(at.getTime() - HOSTED_WAKE_BOOT_MS) } } });
    await prisma.sleepHeard.deleteMany({ where: { heardAt: { lt: new Date(at.getTime() - SLEEP_HEARD_KEEP_MS) } } });
};

// The holds due now, at most the account's share each and the watcher's in all, oldest first.
const dueHolds = async (prisma: PrismaClient, at: Date) => {
    const rows = await prisma.sleepWatch.findMany({
        where: { service: "discord", listenFrom: { lte: at }, sandbox: { removedAt: null, hosted: { isNot: null } } },
        include: { sandbox: { select: { ownerId: true } } },
        orderBy: { heldAt: "asc" },
        take: SLEEP_WATCH_SOCKETS_MAX * 2,
    });
    const perAccount = new Map<string, number>();
    return rows
        .filter((row) => {
            const count = (perAccount.get(row.sandbox.ownerId) ?? 0) + 1;
            perAccount.set(row.sandbox.ownerId, count);
            return count <= SLEEP_WATCHES_PER_ACCOUNT;
        })
        .slice(0, SLEEP_WATCH_SOCKETS_MAX);
};

type WakerDeps = Pick<SleepWatcherDeps, "prisma" | "logger"> & {
    readonly start: (sandboxId: string, now: Date) => Promise<WatchStart>;
    readonly now: () => Date;
};

// Starts a sandbox once for what its watches heard, claimed by marking its holds woken, and settles what came of it.
const createWaker = ({ prisma, logger, start, now }: WakerDeps) => {
    // A start that did not happen: tried again after a backoff, or never for a refusal no retry answers.
    const failed = async (sandboxId: string, error: Error): Promise<void> => {
        if (error instanceof ORPCError && FINAL_REFUSALS.has(error.code)) {
            const dropped = await prisma.sleepWatch.deleteMany({ where: { sandboxId } });
            logger.info({ err: error, sandboxId, dropped: dropped.count }, "sleep watch: the start was refused for good; its holds are dropped");
            return;
        }
        const failing = await prisma.sleepWatch.findFirst({ where: { sandboxId }, select: { failures: true } });
        const failures = failing?.failures ?? 0;
        await prisma.sleepWatch.updateMany({
            where: { sandboxId },
            data: { wokeAt: null, failures: failures + 1, retryAt: new Date(now().getTime() + retryDelayMs(failures)) },
        });
        logger.warn({ err: error, sandboxId }, "sleep watch: the start did not complete; trying again later");
    };
    return async (sandboxId: string): Promise<void> => {
        const at = now();
        const due = { sandboxId, wokeAt: null, OR: [{ retryAt: null }, { retryAt: { lte: at } }] };
        const claimed = await prisma.sleepWatch.updateMany({ where: due, data: { wokeAt: at } });
        if (claimed.count === 0) {
            return;
        }
        const outcome = await start(sandboxId, at);
        switch (outcome.kind) {
            case "started":
                logger.info({ sandboxId }, "sleep watch: a message for the bot starts the sandbox");
                void outcome.settled
                    .then((error) => (error === undefined ? undefined : failed(sandboxId, error)))
                    .catch((error: Error) => logger.warn({ err: error, sandboxId }, "sleep watch: a failed start could not be recorded"));
                return;
            case "booting":
                return;
            case "spent":
                await prisma.sleepWatch.updateMany({ where: { sandboxId }, data: { wokeAt: null, retryAt: nextUtcDay(at) } });
                return;
            case "gone":
                await prisma.sleepWatch.deleteMany({ where: { sandboxId } });
                return;
        }
    };
};

export const createSleepWatcher = (deps: SleepWatcherDeps): SleepWatcher => {
    const { prisma, config, logger } = deps;
    const now = deps.now ?? (() => new Date());
    const watch = deps.watch ?? ((token, hooks) => watchDiscord(token, hooks));
    const wake = createWaker({ prisma, logger, now, start: deps.start ?? requestStart({ prisma, config, logger }) });
    const held = new Map<string, Held>();

    const close = (id: string): void => {
        held.get(id)?.watch.close();
        held.delete(id);
    };

    const heard = (hold: Omit<Held, "watch">): DiscordWatchHooks["heard"] => (message) => {
        void recordSleepHeard(prisma, hold, message, now())
            .then((recorded) => (recorded ? wake(hold.sandboxId) : undefined))
            .catch((error: Error) => logger.warn({ err: error, sandboxId: hold.sandboxId }, "sleep watch: a heard message could not be recorded"));
    };

    const refused = (hold: Omit<Held, "watch">): DiscordWatchHooks["refused"] => (why) => {
        held.delete(hold.id);
        logger.info({ sandboxId: hold.sandboxId, connection: hold.connection, why }, "sleep watch: Discord refused the bot; its hold is dropped");
        void prisma.sleepWatch
            .deleteMany({ where: { id: hold.id } })
            .catch((error: Error) => logger.warn({ err: error, sandboxId: hold.sandboxId }, "sleep watch: a refused hold could not be dropped"));
    };

    const openOne = async (hold: Omit<Held, "watch"> & { readonly credential: string }): Promise<void> => {
        let token: string;
        try {
            token = decryptSecret(config, hold.credential);
        } catch (error) {
            logger.warn({ err: error, sandboxId: hold.sandboxId }, "sleep watch: a held credential could not be read; its hold is dropped");
            await prisma.sleepWatch.deleteMany({ where: { id: hold.id } });
            return;
        }
        const kept = { id: hold.id, sandboxId: hold.sandboxId, service: hold.service, connection: hold.connection };
        const log = logger.child({ sandboxId: hold.sandboxId, connection: hold.connection });
        held.set(hold.id, { ...kept, watch: watch(token, { heard: heard(kept), refused: refused(kept), log }) });
    };

    const sync = async (): Promise<void> => {
        const at = now();
        await pruneStale(prisma, at);
        const holds = await dueHolds(prisma, at);
        const wanted = new Set(holds.map((hold) => hold.id));
        for (const gone of [...held.keys()].filter((key) => !wanted.has(key))) {
            close(gone);
        }
        for (const hold of holds.filter((row) => !held.has(row.id))) {
            await openOne(hold);
        }
        // A start missed or put off: any sandbox whose watches heard something and are not woken.
        const unwoken = [...new Set(holds.filter((hold) => hold.wokeAt === null).map((hold) => hold.sandboxId))];
        const waiting = await prisma.sleepHeard.findMany({ where: { sandboxId: { in: unwoken } }, select: { sandboxId: true }, distinct: ["sandboxId"] });
        for (const { sandboxId } of waiting) {
            await wake(sandboxId);
        }
    };

    return {
        sync,
        open: () => [...held.keys()],
        closeAll: () => {
            for (const key of held.keys()) {
                close(key);
            }
        },
    };
};

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

// The watcher, run for as long as this replica holds the lock and is not stopping.
const runWatcher = async (deps: SleepWatcherDeps, signal: AbortSignal): Promise<void> => {
    const watcher = createSleepWatcher(deps);
    deps.logger.info("sleep watch: this replica holds the sleeping sandboxes' Discord connections");
    try {
        while (!signal.aborted) {
            await watcher.sync().catch((error: Error) => deps.logger.warn({ err: error }, "sleep watch: a pass failed"));
            await pause(SLEEP_WATCH_SYNC_MS, signal);
        }
    } finally {
        watcher.closeAll();
    }
};

/** Starts the watcher on whichever replica takes the lock; answers the stop main.ts awaits on shutdown, which closes
 * every connection. Off unless the hosted lane is on. */
export const startSleepWatches = (prisma: PrismaClient, config: Config, logger: Logger): (() => Promise<void>) => {
    if (!hostedEnabled(config)) {
        return async () => {};
    }
    const stopping = new AbortController();
    let running: Promise<void> | undefined;
    const tick = (): void => {
        if (running !== undefined || stopping.signal.aborted) {
            return;
        }
        running = holdExclusive(config, JOB_SLEEP_WATCH, (lost) => runWatcher({ prisma, config, logger }, AbortSignal.any([lost, stopping.signal])))
            .then(() => undefined)
            .catch((error: Error) => logger.error({ err: error }, "sleep watch: the watcher stopped"))
            .finally(() => {
                running = undefined;
            });
    };
    tick();
    const timer = setInterval(tick, 15_000);
    timer.unref();
    return async () => {
        stopping.abort();
        clearInterval(timer);
        await running;
    };
};
