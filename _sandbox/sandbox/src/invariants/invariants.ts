import type { Logger } from "pino";

/* THE PROMISES THIS DAEMON MAKES TO ITSELF, CHECKED WHILE IT RUNS.
 *
 * This repository states its runtime relationships unusually precisely, in ARCHITECTURE.md, and at the top of
 * the files that own them. Exactly one daemon per container converges HOME. Every live turn is in the journal,
 * so a container recreate cannot eat it. No credential sits in the manifest a turn can Read. None of those is
 * checked after the moment it is established, and every one of them fails SILENTLY: the daemon carries on
 * converging, running and serving, and the cost surfaces days later as lost git access, a forty-minute run that
 * did not come back, or a token in a file the agent read.
 *
 * An invariant is one of those promises, written as code that observes the live state and says so when it stops
 * being true. Three rules keep this from decaying into ceremony:
 *
 *   IT MUST OBSERVE. A check reads an authoritative event stream or mutable data, the claim file, the journal
 *     directory, the two registries that each hold a `running` flag. Asserting that a method exists, that a
 *     module is wired, or that a pure function returns what it returned in the unit test is a type, load or
 *     unit-test concern, and a check that does it is worse than no check: it is a green light with no subject.
 *   IT MUST BE ABLE TO FAIL. A check that never calls `fail` asserts nothing. The gate reads for it.
 *   IT MUST NOT BE THE THING THAT BREAKS. A violation is REPORTED, never thrown at the daemon, a sandbox must
 *     not lose its turn because a diagnostic disagreed with it. A check that throws on its own account is
 *     recorded as a broken check, under its owner's name, so it cannot hide either.
 *
 * OWNERSHIP IS BY SUBSYSTEM, one `invariant.ts` per directory under src/, and it is EXHAUSTIVE: a subsystem
 * either registers a check or says in writing why it has none (verify-invariants.mjs, run by `pnpm check`).
 * Exhaustiveness is the whole mechanism. A registry anyone may contribute to and nobody must is a folder that
 * fills up for two months and is never opened again.
 */

// When a check runs. Named moments rather than a bare timer, because the interesting question differs: `boot`
// asks what the previous life left behind, `turn-settled` asks whether a turn cleaned up after itself, and
// `sweep` is the standing patrol for the relationships nothing in particular disturbs.
export type InvariantMoment = "boot" | "turn-settled" | "sweep";

// Thrown by `fail`, caught by the registry, never seen by the daemon. Carries its owner so a violation can be
// attributed without the check having to repeat its own name in every message.
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
    // Report the promise broken. Throws, so a check reads as a sequence of guards rather than as a flag it
    // must remember to return. The message names what was expected and what was found, it is read by whoever
    // is looking at a log line at 3am, so "expected X, found Y" beats "invalid state".
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
    // True when the check itself threw or timed out rather than reporting a broken promise. A broken check is
    // not evidence about the subject, and reading it as if it were is how a diagnostic starts lying.
    readonly broken: boolean;
}

export interface InvariantRegistry {
    // Register one subsystem's checks. Returns the disposer. A second registration of the same owner, or two
    // checks of one name, throws AT REGISTRATION, that is a wiring mistake, and wiring mistakes are the one
    // class this module is allowed to be loud about, because nothing is running yet.
    readonly register: (owner: string, checks: readonly InvariantCheck[]) => () => void;
    // Run every check armed for this moment. Never rejects. Returns what broke this pass.
    readonly run: (moment: InvariantMoment) => Promise<readonly InvariantViolation[]>;
    // What has broken recently, newest last, bounded. Read by the diagnostics route and by tests.
    readonly violations: () => readonly InvariantViolation[];
    readonly owners: () => readonly string[];
}

// A check reads a file or two. Anything slower than this is a check that has gone wrong, and the sweep must
// not be the thing holding a shutdown open.
const CHECK_TIMEOUT_MS = 5_000;

// Kept small on purpose: this is a live signal, not a ledger. The durable copy is the log line each violation
// writes, which is where anyone investigating one actually looks.
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
    /* Runs are serialized against each other. The sweep and a settling turn can land in the same tick, and two
     * passes reading the same mutable state concurrently would report one broken promise twice, or, worse,
     * catch a subsystem mid-write and report a violation that was never true. */
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
                message: error instanceof Error ? error.message : String(error),
                at: Date.now(),
                broken,
            };
        }
    };

    const pass = async (moment: InvariantMoment): Promise<readonly InvariantViolation[]> => {
        const armed = [...registered].flatMap(([owner, checks]) =>
            checks.filter((check) => check.on.includes(moment)).map((check) => ({ owner, check })),
        );
        // Concurrent within a pass: these are independent reads of independent state, and the sweep should
        // cost one check's latency rather than their sum.
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
                throw new Error(`invariants: '${owner}' is already registered — one companion per subsystem`);
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
