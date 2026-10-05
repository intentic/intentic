import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// THE DAEMON'S HOUSEKEEPING CLOCK (2026-10-05). A chore that should run hourly or daily, not only at boot, and not
// again at every boot of a sandbox that restarts more often than that: when each chore last started is kept on the
// history volume, so a restart storm does not run a daily `git gc` once per restart. One tick looks at every chore;
// a chore runs when its interval has passed since it last started and its own `when` says now is a good time (no live
// turns, typically), and one chore never runs twice at once. The start is recorded before the chore runs, so one that
// throws, or that kills the daemon, waits out its interval rather than running again at the next tick.

const ChoreClockSchema = z.object({
    // Epoch ms each chore last started, by its name.
    ran: z.record(z.string(), z.number()),
});
export const choreClockDocument = defineDocument({ root: "history", path: "chore-clock.json", schema: ChoreClockSchema });
type ChoreClockFile = z.infer<typeof ChoreClockSchema>;

// A clock nothing has run on yet, which is also what an unreadable one reads as.
const emptyClock = (): ChoreClockFile => ({ ran: {} });

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;

// How often the clock looks, and how long after boot it first does: boot's own work (installs, the first turns) goes
// first.
const TICK_MS = 5 * 60_000;
const WARMUP_MS = 2 * 60_000;

export interface Chore {
    // Its key on the clock; renaming one runs it at once, once.
    readonly name: string;
    readonly everyMs: number;
    // Whether now is a good time; absent is always. Read at every tick, so a chore held back runs at the first one that
    // passes.
    readonly when?: () => boolean;
    // Logs what it did itself; a throw is logged here and spends the interval.
    readonly run: () => Promise<void>;
}

export interface ChoreClockDeps {
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "warn">;
    readonly now?: () => number;
    readonly tickMs?: number;
    readonly warmupMs?: number;
}

export interface ChoreClock {
    // One look at every chore, resolved once each that was due has finished; exposed for tests.
    readonly tick: () => Promise<void>;
    readonly stop: () => void;
}

// Whether a chore last started at `lastRan` is due at `now`; a clock that reads the future (a clock step back) is due.
export const choreDue = (lastRan: number | undefined, everyMs: number, now: number): boolean =>
    lastRan === undefined || now < lastRan || now - lastRan >= everyMs;

export const startChoreClock = (deps: ChoreClockDeps, chores: readonly Chore[]): ChoreClock => {
    const now = deps.now ?? Date.now;
    const file = openDocument(choreClockDocument, join(deps.historyRoot, choreClockDocument.path), { fallback: emptyClock });
    const running = new Set<string>();
    const runOne = async (chore: Chore): Promise<void> => {
        running.add(chore.name);
        try {
            const at = now();
            await file.update((current) => ({ ran: { ...current.ran, [chore.name]: at } }));
            await chore.run();
        } catch (error) {
            deps.logger.warn({ err: error, chore: chore.name }, "housekeeping: a chore failed, it runs again after its interval");
        } finally {
            running.delete(chore.name);
        }
    };
    const tick = async (): Promise<void> => {
        const { ran } = await file.read().catch(() => emptyClock());
        const due = chores.filter((chore) => !running.has(chore.name) && choreDue(ran[chore.name], chore.everyMs, now()) && (chore.when?.() ?? true));
        await Promise.all(due.map(runOne));
    };
    let interval: NodeJS.Timeout | undefined;
    const warmup = setTimeout(() => {
        void tick();
        interval = setInterval(() => void tick(), deps.tickMs ?? TICK_MS);
        interval.unref();
    }, deps.warmupMs ?? WARMUP_MS);
    warmup.unref();
    return {
        tick,
        stop: () => {
            clearTimeout(warmup);
            clearInterval(interval);
        },
    };
};
