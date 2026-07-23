import type { AgentEvent, AgentTurn } from "@intentic/sandbox-contract";

/* Detached turn runs — turn EXECUTION decoupled from any client connection. POST /agent starts a run: the
 * turn generator is pumped daemon-side into a seq-stamped frame log, and any number of clients render it by
 * attaching (replay from a cursor, then live). The initiating window holds no special stream — a reload, a
 * second window, or another device attaches the same way, which is what makes a turn survive all of them.
 *
 * A finished run is retained briefly so a client that lost its stream near the end still replays the tail;
 * after that the session store is the record and attach reports NOT_FOUND. Keyed by conversationId — the
 * daemon is single-tenant behind its authenticated tunnel (same bet as agent-steering). */

// The turn generator a run pumps — streamAgent's shape, injected to keep this module cycle-free of
// agent.routes (and swappable in tests).
export type TurnFn = (input: AgentTurn, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

const RETAIN_MS = 5 * 60_000;

export class TurnRun {
    readonly id = crypto.randomUUID();
    readonly startedAt = Date.now();
    private finishedAt: number | undefined;
    private readonly frames: AgentEvent[] = [];
    private waiters: (() => void)[] = [];

    constructor(readonly prompt: string) {}

    get done(): boolean {
        return this.finishedAt !== undefined;
    }

    // True once the run is finished AND past retention — attach then reports NOT_FOUND and the map entry drops.
    expired(now: number): boolean {
        return this.finishedAt !== undefined && now - this.finishedAt > RETAIN_MS;
    }

    // The log length — a frame's seq is its 1-based position, so this is also the last stamped seq.
    get seq(): number {
        return this.frames.length;
    }

    push(event: AgentEvent): void {
        this.frames.push(event);
        this.wake();
    }

    finish(): void {
        this.finishedAt = Date.now();
        this.wake();
    }

    private wake(): void {
        const waiting = this.waiters;
        this.waiters = [];
        for (const resolve of waiting) {
            resolve();
        }
    }

    // Replay frames after `after`, then follow live until the run finishes. Any number of followers may run
    // concurrently. A follower whose consumer disconnects while parked here stays parked until the next
    // push/finish wake — bounded by the turn's end, when every follower drains and returns.
    async *follow(after: number): AsyncGenerator<{ readonly seq: number; readonly event: AgentEvent }> {
        let cursor = Math.min(after, this.frames.length);
        for (;;) {
            while (cursor < this.frames.length) {
                cursor += 1;
                yield { seq: cursor, event: this.frames[cursor - 1]! };
            }
            if (this.done) {
                return;
            }
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
    }
}

const runs = new Map<string, TurnRun>();

const sweep = (): void => {
    const now = Date.now();
    for (const [conversationId, run] of runs) {
        if (run.expired(now)) {
            runs.delete(conversationId);
        }
    }
};

// Start a detached run for the conversation's turn, or undefined when one is already live (the route 409s —
// the client serializes its own turns, so a live run means another window/device is mid-turn). The pump owns
// the generator: a thrown turn is folded into the log as an error frame (an abort — /agent/stop — as a clean
// done), so followers always see the run settle.
export function startTurnRun(turnFn: TurnFn, input: AgentTurn & { conversationId: string }): TurnRun | undefined {
    sweep();
    const existing = runs.get(input.conversationId);
    if (existing !== undefined && !existing.done) {
        return undefined;
    }
    const run = new TurnRun(input.prompt);
    runs.set(input.conversationId, run);
    void (async () => {
        try {
            for await (const event of turnFn(input, undefined)) {
                run.push(event);
            }
        } catch (error) {
            // An abort is /agent/stop doing its job, not a failure — settle with a clean done. Detected by
            // name, not instanceof: Node's DOMException AbortError does not inherit from Error.
            const aborted = typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
            if (!aborted) {
                run.push({ kind: "error", message: error instanceof Error ? error.message : "agent turn failed" });
            }
            run.push({ kind: "done" });
        } finally {
            run.finish();
        }
    })();
    return run;
}

// The conversation's current run — live, or finished within retention. Undefined = nothing to attach to.
export function turnRunOf(conversationId: string): TurnRun | undefined {
    sweep();
    return runs.get(conversationId);
}
