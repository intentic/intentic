import { serialLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import { createFailureTracker } from "../retry/failure-backoff.js";

// Runtime checks for promises the daemon makes to itself that otherwise fail silently. A check must observe live state
// (not wiring or a pure function), must be able to call `fail`, and must never itself throw at the daemon: a violation
// is reported, not thrown. One invariant.ts per subsystem, enforced exhaustively by invariant-registry.mjs.

// When a check runs, named rather than timed: `boot` asks what the previous life left behind, `turn-settled` asks if a
// turn cleaned up, `sweep` is the standing patrol for relationships nothing else disturbs.
export type InvariantMoment = "boot" | "turn-settled" | "sweep";

// Thrown by `fail`, caught by the registry, never seen by the daemon; carries its owner so a violation can be
// attributed without repeating it in every message.
export class InvariantError extends Error {
    readonly code = "INVARIANT";
    constructor(
        readonly owner: string,
        readonly check: string,
        message: string,
    ) {
        super(message);
        this.name = "InvariantError";
    }
}

export interface InvariantRun {
    readonly moment: InvariantMoment;
    // Reports the broken promise; throws so a check reads as guards, not a flag to remember to return.
    readonly fail: (message: string) => never;
}

export interface InvariantCheck {
    // Unique within its owner. Appears in the log line and in the violation record.
    readonly name: string;
    // The moments this check runs at. A check listing none never runs, which the gate rejects.
    readonly on: readonly InvariantMoment[];
    readonly run: (run: InvariantRun) => Promise<void> | void;
}

export interface InvariantViolation {
    readonly owner: string;
    readonly check: string;
    readonly moment: InvariantMoment;
    readonly message: string;
    readonly at: number;
    // True when the check itself threw or timed out rather than calling `fail`: nothing was learned about the subject.
    // Named for what it says, since a field called `broken` read `false` on every line that reported a broken promise.
    readonly checkFailed: boolean;
}

export interface InvariantRegistry {
    // Registers a subsystem's checks, returns the disposer; a duplicate owner or check name throws immediately.
    readonly register: (owner: string, checks: readonly InvariantCheck[]) => () => void;
    // Run every check armed for this moment. Never rejects. Returns what broke this pass.
    readonly run: (moment: InvariantMoment) => Promise<readonly InvariantViolation[]>;
    // Each violation as it appeared or changed, newest last, bounded; one standing unchanged is in here once.
    readonly violations: () => readonly InvariantViolation[];
    readonly owners: () => readonly string[];
}

// A check reads a file or two; slower than this means gone wrong, and the sweep must not hold shutdown open.
const CHECK_TIMEOUT_MS = 5_000;

// A deadline timer firing this late was held up by a stalled event loop, which also holds the check's finished I/O
// behind it: timers run before I/O callbacks, so expiring here would blame a healthy check for the stall.
const STALLED_BY_MS = 1_000;

// How many stalls may restart one check's allowance, so a check hung through a thrashing machine still expires.
const MAX_STALL_RESTARTS = 3;

// A check that could not run (it timed out, it threw) is left out of the passes after it for a wait that doubles from this
// floor to the cap, and its failure is written once per outage rather than on every flap between running and not
// (35 lines of one timed-out check in a week). A violation it finds is the subject's state, not the check's, and keeps
// its own rule below.
const UNRUNNABLE_BACKOFF = { floorMs: 10 * 60_000, capMs: 6 * 60 * 60_000 };

// A live signal, not a ledger; the durable copy is the log line each violation writes.
const MAX_VIOLATIONS = 200;

// Races `work` against `ms` of running time: a stall restarts the allowance rather than spending it.
const deadline = async (work: Promise<void> | void, ms: number): Promise<void> => {
    if (!(work instanceof Promise)) {
        return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                const arm = (restarts: number): void => {
                    const due = Date.now() + ms;
                    timer = setTimeout(() => {
                        if (Date.now() - due > STALLED_BY_MS && restarts < MAX_STALL_RESTARTS) {
                            arm(restarts + 1);
                            return;
                        }
                        reject(new Error(`check did not settle within ${ms}ms`));
                    }, ms);
                };
                arm(0);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

// One check under its deadline: undefined when it held, else what it found or why it could not run.
const runOne = async (owner: string, check: InvariantCheck, moment: InvariantMoment): Promise<InvariantViolation | undefined> => {
    const fail = (message: string): never => {
        throw new InvariantError(owner, check.name, message);
    };
    try {
        await deadline(check.run({ moment, fail }), CHECK_TIMEOUT_MS);
        return undefined;
    } catch (error) {
        return {
            owner,
            check: check.name,
            moment,
            message: errorMessage(error),
            at: Date.now(),
            checkFailed: !(error instanceof InvariantError),
        };
    }
};

export const createInvariantRegistry = (logger: Logger): InvariantRegistry => {
    const registered = new Map<string, readonly InvariantCheck[]>();
    const seen: InvariantViolation[] = [];
    // What each failing check last reported, keyed `${owner}\0${check}`: a violation standing unchanged across passes
    // is recorded once, or one stuck check fills the log and evicts every other violation from `seen`.
    const standing = new Map<string, string>();
    // Serializes runs: concurrent passes over shared state could double-report or catch a subsystem mid-write. Each pass
    // runs after the last however it ended, so a pass that throws past `runOne` (a logger that fails) loses only itself.
    const serially = serialLock();
    const unrunnable = createFailureTracker({ backoff: UNRUNNABLE_BACKOFF });

    const record = (violation: InvariantViolation, log = true): void => {
        const key = `${violation.owner}\u0000${violation.check}`;
        const signature = `${violation.checkFailed}\u0000${violation.message}`;
        if (standing.get(key) === signature) {
            return;
        }
        standing.set(key, signature);
        seen.push(violation);
        if (seen.length > MAX_VIOLATIONS) {
            seen.splice(0, seen.length - MAX_VIOLATIONS);
        }
        // Warn, not error: a violation is drift the daemon goes on working around (each owner's own handling), and a
        // check that could not run says nothing about its subject. Written once per change of what it reports, and
        // once per boot for one still standing, since each daemon states what it found.
        if (!log) {
            return;
        }
        logger.warn(
            { owner: violation.owner, check: violation.check, moment: violation.moment, checkFailed: violation.checkFailed },
            violation.checkFailed ? `invariant check failed to run: ${violation.message}` : `invariant violated: ${violation.message}`,
        );
    };

    const recovered = (owner: string, check: string, moment: InvariantMoment): void => {
        const key = `${owner}\u0000${check}`;
        const wasUnrunnable = standing.get(key)?.startsWith("true\u0000") === true;
        const unrunnableOutage = unrunnable.succeeded(key);
        // A check that only failed to run says it runs again when its failure was written, not after a quiet flap.
        if (standing.delete(key) && (!wasUnrunnable || unrunnableOutage !== undefined)) {
            logger.info({ owner, check, moment }, "invariant holds again");
        }
    };

    const pass = async (moment: InvariantMoment): Promise<readonly InvariantViolation[]> => {
        const armed = [...registered].flatMap(([owner, checks]) =>
            checks.filter((check) => check.on.includes(moment) && unrunnable.due(`${owner}\u0000${check.name}`)).map((check) => ({ owner, check })),
        );
        // Concurrent within a pass: independent reads of independent state cost one check's latency, not the sum.
        const results = await Promise.all(armed.map(({ owner, check }) => runOne(owner, check, moment)));
        for (const [index, result] of results.entries()) {
            if (result === undefined) {
                const { owner, check } = armed[index]!;
                recovered(owner, check.name, moment);
                continue;
            }
            const key = `${result.owner}\u0000${result.check}`;
            if (result.checkFailed) {
                record(result, unrunnable.failed(key, result.message).log);
                continue;
            }
            unrunnable.succeeded(key);
            record(result);
        }
        return results.filter((result) => result !== undefined);
    };

    return {
        register: (owner, checks) => {
            if (registered.has(owner)) {
                throw new Error(`invariants: '${owner}' is already registered, one companion per subsystem`);
            }
            const names = new Set<string>();
            for (const check of checks) {
                if (names.has(check.name)) {
                    throw new Error(`invariants: '${owner}' registers two checks named '${check.name}'`);
                }
                names.add(check.name);
            }
            registered.set(owner, checks);
            return () => {
                registered.delete(owner);
                for (const key of standing.keys()) {
                    if (key.startsWith(`${owner}\u0000`)) {
                        standing.delete(key);
                    }
                }
            };
        },
        run: (moment) => serially(() => pass(moment)),
        violations: () => [...seen],
        owners: () => [...registered.keys()].toSorted(),
    };
};
