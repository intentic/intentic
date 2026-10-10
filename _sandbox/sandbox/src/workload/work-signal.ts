import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import type { Logger } from "pino";
import { opt } from "../opt.js";
import type { DomainEvents } from "../seams/domain-events.js";
import type { QuietReading } from "../system/quiet-watch.js";

// HOW MUCH WORK IS IN FLIGHT, FOR THE HOST. The machine agent's keeper restarts a sandbox unasked when its tunnel or its
// registration is broken (ic: sandbox/fix/chain.rs), and a restart cuts every turn in flight. ic reads this file
// through `docker exec` first, and while work runs it asks for a yes instead of restarting by itself. The count keeps
// the name ic reads, `liveTurns`, and since 2026-10-05 counts everything a restart would cut (bootstrap/working-now.ts,
// purpose "restart": turns, lands, running subagents, workflows' steps), as an update and a device rebuild wait for:
// the keeper's restart cuts a land as surely as theirs does. On /run, never on
// /health: /health answers the public address too, and whether anyone is working here right now is nobody else's
// business.
export const WORK_SIGNAL_PATH = "/run/intentic/work.json";

// Events say a turn began or ended at once; the poll catches what no event announces (a spawned child's own turns run
// through the port's `run`) and keeps `at` fresh, so ic can tell a live count from one a hung daemon left behind.
const POLL_MS = 10_000;
const REFRESH_MS = 60_000;

// What the signal says about this boot (2026-10-05), so a keeper deciding on a restart can see the sandbox is already in
// a storm of them: when this daemon booted, the boot before it, how many boots fell in the storm window, whether that
// made a storm (system/boot/boot-history.ts), and when the restart this boot follows was asked for (restart-resume.ts),
// which `ic` writes before every restart it makes.
export interface WorkSignalBoot {
    readonly bootedAt: number;
    readonly previousBootAt?: number;
    readonly bootsInWindow: number;
    readonly storm: boolean;
    readonly restartAskedAt?: number;
}

export interface WorkSignalDeps {
    // How many things a restart would cut right now.
    readonly working: () => number;
    // This boot's facts once known; absent for a daemon that keeps no boot record.
    readonly boot?: () => Promise<WorkSignalBoot | undefined>;
    // Since when nobody has needed the sandbox, and its soonest promised wake (system/quiet-watch.ts): what the host's
    // keeper puts a sandbox to sleep on (ic: `sandbox sleep --idle`). Absent for a daemon that offers no sleep.
    readonly quiet?: () => QuietReading;
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

// `liveTurns` and `at` first and always, as every keeper reads them; the boot's facts after, when known, then the quiet
// reading, whose fields are absent whenever they say nothing (busy, no wake promised).
export const workSignalBody = (liveTurns: number, at: number, boot?: WorkSignalBoot, quiet?: QuietReading): string =>
    `${JSON.stringify({
        liveTurns,
        at,
        ...opt("bootedAt", boot?.bootedAt),
        ...opt("previousBootAt", boot?.previousBootAt),
        ...opt("bootsInWindow", boot?.bootsInWindow),
        ...opt("restartStorm", boot?.storm),
        ...opt("lastRestartAt", boot?.restartAskedAt),
        ...opt("quietSince", quiet?.quietSince),
        ...opt("nextWakeAt", quiet?.nextWakeAt),
    })}\n`;

export const startWorkSignal = ({ working, events, logger, boot, quiet, path = WORK_SIGNAL_PATH, now = Date.now }: WorkSignalDeps): WorkSignal => {
    let written: { liveTurns: number; at: number; quiet: QuietReading | undefined } | undefined;
    let failing = false;
    let chain: Promise<void> = Promise.resolve();
    // Read once: a boot's facts never change after it.
    const booted =
        boot?.().catch((error: unknown) => {
            logger.warn({ err: error }, "the work signal could not read this boot's facts, so it carries none");
            return undefined;
        }) ?? Promise.resolve(undefined);
    const write = async (): Promise<void> => {
        const liveTurns = working();
        const at = now();
        const reading = quiet?.();
        const quietSame = written?.quiet?.quietSince === reading?.quietSince && written?.quiet?.nextWakeAt === reading?.nextWakeAt;
        if (written !== undefined && written.liveTurns === liveTurns && quietSame && at - written.at < REFRESH_MS) {
            return;
        }
        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFileAtomic(path, workSignalBody(liveTurns, at, await booted, reading));
            written = { liveTurns, at, quiet: reading };
            failing = false;
        } catch (error) {
            // Said once per stretch: a daemon without /run/intentic (a dev daemon on a laptop) has no host to tell.
            if (!failing) {
                logger.warn({ err: error, path }, "the work signal could not be written; the host's keeper cannot see running turns");
            }
            failing = true;
        }
    };
    // One write at a time, in order, so a stale count never lands after a fresher one; both arms, so a write that threw
    // does not leave the chain rejected and every later tick with it.
    const tick = (): Promise<void> => {
        chain = chain.then(write, write);
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
