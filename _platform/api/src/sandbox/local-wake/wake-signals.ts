import type { PrismaClient } from "@intentic/prisma";
import { Client, type Notification } from "pg";
import type { Logger } from "pino";
import type { Config } from "../../config.js";

/* "SOMEBODY ASKED FOR THIS SANDBOX", SAID TO WHOEVER HOLDS ITS MACHINE'S ASK (2026-10-19). A machine whose sandboxes
 * sleep may hold its wakes ask open here (host-report.ts, POST /host-report/wakes), and `sandbox.wake` says through
 * this hub that a request was just stamped, so the held ask answers at once instead of on its next look. The stamp in
 * `wakeRequestedAt` stays the truth: a signal only says "look now", and losing one costs the held ask's re-check
 * interval, never the wake.
 *
 * The api runs as several replicas, so the browser's wake and the machine's held ask can be on different ones. A wake
 * is said here in two ways: to this process's waiters directly, and to every replica through Postgres `NOTIFY` on
 * WAKE_CHANNEL, which each replica hears on one connection of its own kept `LISTEN`ing. That connection is a plain `pg`
 * client on DATABASE_URL, as jobs-lock.ts's advisory locks are, so it needs the same thing they do: a session that
 * lasts, which a transaction-pooling proxy in front of Postgres would not give. The replica that said it hears its own
 * notification too, which ends nothing: its waiters were already told.
 *
 * Rejected: a hub in each process only (a wake landing on another replica than the held ask would wait for the
 * re-check, as often as not), and a second store or broker for one message type (Postgres is already shared by every
 * replica). */

// The channel every replica listens on; its payload is a tunnel id.
export const WAKE_CHANNEL = `sandbox_wake`;

// How long a replica waits before listening again after its connection failed, doubling to a ceiling: the database
// restarting is the common case, and a minute of held asks re-checking on their own costs little.
export const LISTEN_RETRY_FIRST_MS = 1000;
const LISTEN_RETRY_MAX_MS = 30_000;

// How a wait ended: a signal for one of its sandboxes, its time running out, or its abort signal or the hub stopping.
export type WakeWaitEnd = `signal` | `timeout` | `abort`;

export interface WakeSignals {
    // Resolves when any of `tunnelIds` is signalled, after `ms`, or once `abort` fires, whichever is first, and never
    // rejects. The wait is registered as the call returns, so a signal sent after the call and before its promise is
    // awaited ends it all the same: a caller listens first and reads the database second, and misses nothing between.
    readonly wait: (tunnelIds: readonly string[], ms: number, abort?: AbortSignal) => Promise<WakeWaitEnd>;
    // Ends every wait in this process on `tunnelId`.
    readonly fire: (tunnelId: string) => void;
    // Says it to every replica: this process's waiters at once, the others' through Postgres. Never rejects, since the
    // wake that calls it must not fail on it.
    readonly notify: (tunnelId: string) => Promise<void>;
    // How many waits are registered: the suites check that every way a wait ends leaves none behind.
    readonly waiting: () => number;
    // Ends every wait as aborted, and every later one at once, so a held ask answers rather than holding the shutdown
    // up for its whole hold; the machine's next ask lands on a replica that is still serving.
    readonly stop: () => Promise<void>;
}

interface WaitTable {
    readonly wait: WakeSignals[`wait`];
    readonly fire: (tunnelId: string) => void;
    // Ends every wait, for when signals may have been missed (the listener was down) and every holder should look.
    readonly fireAll: () => void;
    readonly waiting: () => number;
    readonly close: () => void;
}

// The waiters, by tunnel id. A wait on several ids sits under each, and leaves every one of them however it ends.
const waitTable = (): WaitTable => {
    const byId = new Map<string, Set<(end: WakeWaitEnd) => void>>();
    const live = new Set<(end: WakeWaitEnd) => void>();
    let closed = false;
    const wait = (tunnelIds: readonly string[], ms: number, abort?: AbortSignal): Promise<WakeWaitEnd> =>
        new Promise((resolve) => {
            if (closed || abort?.aborted === true) {
                resolve(`abort`);
                return;
            }
            const ids = [...new Set(tunnelIds)];
            const onAbort = (): void => settle(`abort`);
            // Called only once `timer` below is set: nothing settles a wait before this executor has returned.
            const settle = (end: WakeWaitEnd): void => {
                // Settled once: of a signal, the timer and the abort, whichever comes later finds it gone.
                if (!live.delete(settle)) {
                    return;
                }
                clearTimeout(timer);
                abort?.removeEventListener(`abort`, onAbort);
                for (const id of ids) {
                    const waiters = byId.get(id);
                    waiters?.delete(settle);
                    if (waiters?.size === 0) {
                        byId.delete(id);
                    }
                }
                resolve(end);
            };
            live.add(settle);
            for (const id of ids) {
                const waiters = byId.get(id) ?? new Set();
                waiters.add(settle);
                byId.set(id, waiters);
            }
            abort?.addEventListener(`abort`, onAbort, { once: true });
            const timer = setTimeout(() => settle(`timeout`), Math.max(0, ms));
        });
    const fire = (tunnelId: string): void => {
        // A settled wait leaves the set it is read from, which a Set's iteration allows.
        for (const settle of byId.get(tunnelId) ?? []) {
            settle(`signal`);
        }
    };
    const endAll = (end: WakeWaitEnd): void => {
        for (const settle of live) {
            settle(end);
        }
    };
    const close = (): void => {
        closed = true;
        endAll(`abort`);
    };
    return { wait, fire, fireAll: () => endAll(`signal`), waiting: () => live.size, close };
};

// A hub that reaches this process only: what an app built without a database is handed (the suites), and all one
// process serving alone would need.
export const localWakeSignals = (): WakeSignals => {
    const table = waitTable();
    return {
        wait: table.wait,
        fire: table.fire,
        notify: async (tunnelId) => table.fire(tunnelId),
        waiting: table.waiting,
        stop: async () => table.close(),
    };
};

// The part of a `pg` client the listener uses, so a suite can stand one in.
export interface ListenClient {
    connect(): Promise<object | void>;
    query(text: string): Promise<object>;
    end(): Promise<void>;
    on(event: `error`, listener: (error: Error) => void): void;
    on(event: `end`, listener: () => void): void;
    on(event: `notification`, listener: (message: Notification) => void): void;
}

export interface WakeSignalsDeps {
    readonly config: Config;
    readonly prisma: Pick<PrismaClient, `$executeRaw`>;
    readonly logger: Logger;
    // A fresh connection for each time it listens; a `pg` client on DATABASE_URL unless a suite hands its own.
    readonly connect?: () => ListenClient;
}

// TCP keepalive, so a connection a network dropped without a word is found dead rather than never heard from again.
const pgClient = (config: Config) => (): ListenClient => new Client({ connectionString: config.database.url, keepAlive: true });

// Says once each time the hub starts or stops hearing the other replicas, rather than once per attempt.
const listeningSayer = (logger: Logger): ((now: boolean, error?: Error) => void) => {
    let listening: boolean | undefined;
    return (now, error) => {
        if (listening === now) {
            return;
        }
        listening = now;
        if (now) {
            logger.info({ channel: WAKE_CHANNEL }, `wake signals: listening, so a held wakes ask hears a wake made on any replica at once`);
        } else {
            logger.warn(
                { err: error, channel: WAKE_CHANNEL },
                `wake signals: not listening, so a held wakes ask hears a wake made on another replica only when it looks again; retrying`,
            );
        }
    };
};

// A wake said to this process's waiters at once, then to every replica's through Postgres. Never rejects: the stamp
// `sandbox.wake` wrote is what a held ask reads, and the signal only makes it read sooner.
const notifier =
    (prisma: Pick<PrismaClient, `$executeRaw`>, logger: Logger, fire: (tunnelId: string) => void) =>
    async (tunnelId: string): Promise<void> => {
        fire(tunnelId);
        try {
            await prisma.$executeRaw`SELECT pg_notify(${WAKE_CHANNEL}, ${tunnelId})`;
        } catch (error) {
            logger.warn({ err: error, tunnelId }, `wake signals: could not tell the other replicas; a held ask there finds the wake when it looks again`);
        }
    };

/* The hub that reaches every replica, started once by main.ts and stopped on its shutdown. It listens on a connection
 * of its own and listens again after losing it, with a backoff from LISTEN_RETRY_FIRST_MS to LISTEN_RETRY_MAX_MS, and
 * says so once each time it starts or stops hearing the other replicas rather than once per attempt. Whatever was
 * notified while it was not listening is lost, so on listening again every wait in this process ends and its holder
 * reads the database, instead of each waiting out its re-check. */
export const startWakeSignals = ({ config, prisma, logger, connect = pgClient(config) }: WakeSignalsDeps): WakeSignals => {
    const table = waitTable();
    let client: ListenClient | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;
    const say = listeningSayer(logger);

    const again = (error: Error): void => {
        if (stopped) {
            return;
        }
        say(false, error);
        retry = setTimeout(() => void listen(), Math.min(LISTEN_RETRY_FIRST_MS * 2 ** failures, LISTEN_RETRY_MAX_MS));
        failures += 1;
    };

    const listen = async (): Promise<void> => {
        retry = undefined;
        if (stopped) {
            return;
        }
        let next: ListenClient;
        try {
            next = connect();
        } catch (error) {
            again(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        let lost = false;
        const lose = (error: Error): void => {
            if (lost) {
                return;
            }
            lost = true;
            if (client === next) {
                client = undefined;
            }
            // allow(silent-catch): the connection is already lost; ending it only lets go of its socket.
            next.end().catch(() => undefined);
            again(error);
        };
        next.on(`error`, lose);
        next.on(`end`, () => lose(new Error(`the listening connection ended`)));
        next.on(`notification`, (message) => {
            if (message.channel === WAKE_CHANNEL && message.payload !== undefined && message.payload !== ``) {
                table.fire(message.payload);
            }
        });
        try {
            await next.connect();
            await next.query(`LISTEN ${WAKE_CHANNEL}`);
        } catch (error) {
            lose(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        if (lost) {
            return;
        }
        if (stopped) {
            // allow(silent-catch): stopping; a connection that will not close cleanly is closed all the same.
            await next.end().catch(() => undefined);
            return;
        }
        client = next;
        failures = 0;
        say(true);
        table.fireAll();
    };

    void listen();

    return {
        wait: table.wait,
        fire: table.fire,
        notify: notifier(prisma, logger, table.fire),
        waiting: table.waiting,
        stop: async () => {
            stopped = true;
            table.close();
            clearTimeout(retry);
            const held = client;
            client = undefined;
            // allow(silent-catch): shutting down; nothing is left to tell about a connection that closed badly.
            await held?.end().catch(() => undefined);
        },
    };
};
