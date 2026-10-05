import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import type { Logger } from "pino";
import type { DomainEvents } from "../seams/domain-events.js";

// HOW MANY AGENT TURNS ARE RUNNING, FOR THE HOST. The machine agent's keeper restarts a sandbox unasked when its tunnel
// or its registration is broken (ic: sandbox/fix/chain.rs), and a restart cuts every turn in flight. ic reads this file
// through `docker exec` first, and while turns run it asks for a yes instead of restarting by itself. On /run, never on
// /health: /health answers the public address too, and whether anyone is working here right now is nobody else's
// business.
export const WORK_SIGNAL_PATH = "/run/intentic/work.json";

// Events say a turn began or ended at once; the poll catches what no event announces (a spawned child's own turns run
// through the port's `run`) and keeps `at` fresh, so ic can tell a live count from one a hung daemon left behind.
const POLL_MS = 10_000;
const REFRESH_MS = 60_000;

export interface WorkSignalDeps {
    readonly conversations: { readonly liveSessionIds: () => readonly string[] };
    readonly events: Pick<DomainEvents, "subscribe">;
    readonly logger: Pick<Logger, "warn">;
    readonly path?: string;
    readonly now?: () => number;
}

export interface WorkSignal {
    // Writes now when the count changed or the last write is old; resolves when it is on disk.
    readonly tick: () => Promise<void>;
    readonly stop: () => void;
}

export const workSignalBody = (liveTurns: number, at: number): string => `${JSON.stringify({ liveTurns, at })}\n`;

export const startWorkSignal = ({ conversations, events, logger, path = WORK_SIGNAL_PATH, now = Date.now }: WorkSignalDeps): WorkSignal => {
    let written: { liveTurns: number; at: number } | undefined;
    let failing = false;
    let chain: Promise<void> = Promise.resolve();
    const write = async (): Promise<void> => {
        const liveTurns = conversations.liveSessionIds().length;
        const at = now();
        if (written !== undefined && written.liveTurns === liveTurns && at - written.at < REFRESH_MS) {
            return;
        }
        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFileAtomic(path, workSignalBody(liveTurns, at));
            written = { liveTurns, at };
            failing = false;
        } catch (error) {
            // Said once per stretch: a daemon without /run/intentic (a dev daemon on a laptop) has no host to tell.
            if (!failing) {
                logger.warn({ err: error, path }, "the work signal could not be written; the host's keeper cannot see running turns");
            }
            failing = true;
        }
    };
    // One write at a time, in order, so a stale count never lands after a fresher one.
    const tick = (): Promise<void> => {
        chain = chain.then(write);
        return chain;
    };
    // After the event has been handled, so the actor's own state already says whether the turn runs.
    const soon = (): void => {
        setTimeout(() => void tick(), 0).unref();
    };
    const unsubscribes = [events.subscribe("run.started", soon), events.subscribe("run.settled", soon)];
    const timer = setInterval(() => void tick(), POLL_MS);
    timer.unref();
    void tick();
    return {
        tick,
        stop: () => {
            clearInterval(timer);
            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        },
    };
};
