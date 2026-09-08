import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";

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
    // True when the check itself threw or timed out, not a reported violation; not evidence about the subject.
    readonly broken: boolean;
}

export interface InvariantRegistry {
    // Registers a subsystem's checks, returns the disposer; a duplicate owner or check name throws immediately.
    readonly register: (owner: string, checks: readonly InvariantCheck[]) => () => void;
    // Run every check armed for this moment. Never rejects. Returns what broke this pass.
    readonly run: (moment: InvariantMoment) => Promise<readonly InvariantViolation[]>;
    // What has broken recently, newest last, bounded. Read by the diagnostics route and by tests.
    readonly violations: () => readonly InvariantViolation[];
    readonly owners: () => readonly string[];
}

// A check reads a file or two; slower than this means gone wrong, and the sweep must not hold shutdown open.
const CHECK_TIMEOUT_MS = 5_000;

// A live signal, not a ledger; the durable copy is the log line each violation writes.
const MAX_VIOLATIONS = 200;

const deadline = async (work: Promise<void> | void, ms: number): Promise<void> => {
    if (!(work instanceof Promise)) {
        return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`check did not settle within ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export const createInvariantRegistry = (logger: Logger): InvariantRegistry => {
    const registered = new Map<string, readonly InvariantCheck[]>();
    const seen: InvariantViolation[] = [];
    // Serializes runs: concurrent passes over shared state could double-report or catch a subsystem mid-write.
    let queue: Promise<readonly InvariantViolation[]> = Promise.resolve([]);

    const record = (violation: InvariantViolation): void => {
        seen.push(violation);
        if (seen.length > MAX_VIOLATIONS) {
            seen.splice(0, seen.length - MAX_VIOLATIONS);
        }
        logger.error(
            { owner: violation.owner, check: violation.check, moment: violation.moment, broken: violation.broken },
            violation.broken ? `invariant check failed to run: ${violation.message}` : `invariant broken: ${violation.message}`,
        );
    };

    const runOne = async (owner: string, check: InvariantCheck, moment: InvariantMoment): Promise<InvariantViolation | undefined> => {
        const fail = (message: string): never => {
            throw new InvariantError(owner, check.name, message);
        };
        try {
            await deadline(check.run({ moment, fail }), CHECK_TIMEOUT_MS);
            return undefined;
        } catch (error) {
            const broken = !(error instanceof InvariantError);
            return {
                owner,
                check: check.name,
                moment,
                message: errorMessage(error),
                at: Date.now(),
                broken,
            };
        }
    };

    const pass = async (moment: InvariantMoment): Promise<readonly InvariantViolation[]> => {
        const armed = [...registered].flatMap(([owner, checks]) =>
            checks.filter((check) => check.on.includes(moment)).map((check) => ({ owner, check })),
        );
        // Concurrent within a pass: independent reads of independent state cost one check's latency, not the sum.
        const results = await Promise.all(armed.map(({ owner, check }) => runOne(owner, check, moment)));
        const broken = results.filter((result) => result !== undefined);
        for (const violation of broken) {
            record(violation);
        }
        return broken;
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
            };
        },
        run: (moment) => {
            queue = queue.then(() => pass(moment));
            return queue;
        },
        violations: () => [...seen],
        owners: () => [...registered.keys()].toSorted(),
    };
};
