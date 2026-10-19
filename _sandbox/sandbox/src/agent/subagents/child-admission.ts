/* ONE ADMISSION FOR EVERY MOVE A PARENT MAKES ON ITS CHILDREN.

   A spawn, a message, a move onto another provider and a fallback the sandbox makes by itself were each let through by
   their own run of checks (a schema, the delegation depth, the records' spent marks, the owner's rules and the taint
   floor), written out at each door in its own order, and a refusal said only its sentence. Each move now runs one list
   of named gates, in order: the first refusal ends it, a hold (the owner must allow it) goes on only if nothing after it
   refuses, and every move that does not simply go is written to the log with the gate that decided it, so "why did this
   child not start" is one log line rather than a reading of four call sites. What a move then claims (a seat among its
   parent's children, a place on its provider's lane, room in memory) is the start's own business (children.ts startChild),
   since each of those is a wait that ends by itself rather than a verdict. */

// What a parent asks for: a new child, words to one, its next turn on another provider, or the sandbox moving it onto
// a fallback by itself.
export type ChildMoveKind = "spawn" | "send" | "answer" | "rehome" | "fallback";

// The gates a move can be stopped at, by name.
export type GateName = "schema" | "depth" | "child-state" | "spent" | "rules";

// One gate's answer: let it through, hold it for the owner, or refuse it with words for the parent.
export type GateAnswer = { readonly pass: true } | { readonly hold: string } | { readonly refuse: string };

export interface ChildGate<Context> {
    readonly name: GateName;
    readonly judge: (context: Context) => GateAnswer | Promise<GateAnswer>;
}

// The move's verdict: it goes, it waits on the owner (the gate that held it and why), or it is refused (the gate and the
// parent's words).
export type AdmissionVerdict =
    | { readonly kind: "proceed" }
    | { readonly kind: "hold"; readonly gate: GateName; readonly reason: string }
    | { readonly kind: "refuse"; readonly gate: GateName; readonly message: string };

export const PASS: GateAnswer = { pass: true };

// Where a verdict that is not a plain go is written down.
export interface AdmissionLog {
    readonly info: (fields: Record<string, string>, message: string) => void;
}

/**
 * Runs a move through its gates in order. A refusal ends it at once; the first hold stands unless a later gate refuses,
 * since the owner's yes cannot make a refused move go. Logged once, with the gate that decided, unless it simply went.
 */
export const admitMove = async <Context>(
    gates: readonly ChildGate<Context>[],
    context: Context,
    move: { readonly kind: ChildMoveKind; readonly parent: string; readonly child?: string },
    log: AdmissionLog,
): Promise<AdmissionVerdict> => {
    let held: Extract<AdmissionVerdict, { readonly kind: "hold" }> | undefined;
    for (const gate of gates) {
        const answer = await gate.judge(context);
        if ("refuse" in answer) {
            log.info({ ...describe(move), gate: gate.name, verdict: "refuse", why: answer.refuse }, "subagents: a move was refused");
            return { kind: "refuse", gate: gate.name, message: answer.refuse };
        }
        if ("hold" in answer && held === undefined) {
            held = { kind: "hold", gate: gate.name, reason: answer.hold };
        }
    }
    if (held !== undefined) {
        log.info({ ...describe(move), gate: held.gate, verdict: "hold", why: held.reason }, "subagents: a move waits on the owner");
        return held;
    }
    return { kind: "proceed" };
};

const describe = (move: { readonly kind: ChildMoveKind; readonly parent: string; readonly child?: string }): Record<string, string> =>
    move.child === undefined ? { move: move.kind, parent: move.parent } : { move: move.kind, parent: move.parent, child: move.child };

/* A START WAITING FOR A SEAT. A parent at its "at once" ceiling had its next spawn refused, and had to remember to spawn
   it again once a child ended; a fan-out wider than the ceiling (twenty-five reviewers under a ceiling of twenty) lost
   its tail. A spawn past the ceiling now waits as pending, in the order it was asked, and starts by itself as a seat
   among its parent's children frees. The lifetime budget is still a refusal: nothing ends to free it. In this process's
   memory, rebuilt at boot from the held starts in spawned-children.ts. */

export interface SeatWaiter {
    readonly childId: string;
    // Starts it now that a seat freed; answers whether it took the seat, else it goes back to the head of the line.
    readonly start: () => Promise<boolean>;
}

export interface SeatLine {
    readonly wait: (parent: string, waiter: SeatWaiter) => void;
    // Takes a waiting start back off the line (its parent cancelled it); answers whether it was waiting.
    readonly withdraw: (parent: string, childId: string) => boolean;
    // A seat of this parent's freed: the oldest waiting start goes.
    readonly freed: (parent: string) => void;
    readonly waiting: (parent: string) => number;
    readonly reset: () => void;
}

export const seatLine = (): SeatLine => {
    const lines = new Map<string, SeatWaiter[]>();
    // One release at a time per parent, so two seats freeing together start two waiters rather than one twice.
    const releasing = new Set<string>();
    const release = async (parent: string): Promise<void> => {
        if (releasing.has(parent)) {
            return;
        }
        releasing.add(parent);
        try {
            const line = lines.get(parent);
            for (let next = line?.shift(); next !== undefined; next = line?.shift()) {
                if (!(await next.start())) {
                    line?.unshift(next);
                    break;
                }
            }
            if (line?.length === 0) {
                lines.delete(parent);
            }
        } finally {
            releasing.delete(parent);
        }
    };
    return {
        wait: (parent, waiter) => {
            const line = lines.get(parent) ?? [];
            line.push(waiter);
            lines.set(parent, line);
        },
        withdraw: (parent, childId) => {
            const line = lines.get(parent);
            const at = line?.findIndex((waiter) => waiter.childId === childId) ?? -1;
            if (line === undefined || at < 0) {
                return false;
            }
            line.splice(at, 1);
            return true;
        },
        freed: (parent) => void release(parent),
        waiting: (parent) => lines.get(parent)?.length ?? 0,
        reset: () => lines.clear(),
    };
};
