import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { RunnerHeldTurn } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";

/* THE TURNS THIS RUNNER RUNS FOR ITS PARENT, one per conversation, owned here rather than by the socket that dispatched
   them. A turn used to be pulled through the parent's stream: when that socket dropped, nothing read the turn any more,
   so it stalled at its next frame with its provider still spending, never settled, and answered every later turn busy
   (2026-11-04, two turns on omen). Here the turn is pumped to its end whoever listens, every frame it makes is kept in
   order, and a parent that comes back reads on from the frame it last saw (runner-dispatch.ts). */

// How long a finished turn's frames wait for a parent that never collects them; collecting (its branch's push) drops them
// at once. A day covers a laptop shut overnight.
const HELD_TURN_RETAINED_MS = 24 * 60 * 60 * 1000;

// Past this, a turn's oldest frames are let go: a replay from before them opens with a notice saying so. Far above any
// real turn (a half-hour turn with hundreds of tool calls is a few MiB), it only bounds a runaway one.
const HELD_TURN_BUDGET_BYTES = 64 * 1024 * 1024;

// How long a push waits for a turn that already said `done` to finish unwinding, so the branch it delivers is final.
const SETTLE_MS = 10_000;

const sizeOf = (event: AgentEvent): number => {
    try {
        return JSON.stringify(event).length;
    } catch {
        // allow(silent-catch): an unserializable frame could not cross the socket either; it costs nothing here.
        return 0;
    }
};

const droppedNotice = (count: number): AgentEvent => ({
    kind: "agent_notice",
    level: "warning",
    text: `${count} of this turn's earlier frames were too many to keep on the runner, so what is shown here starts after them.`,
});

// What reading one position gave: the frame, and the position to read next.
interface FrameRead {
    readonly event: AgentEvent;
    readonly next: number;
}

// One held turn: its frames in order (the first kept one is frame number `base`, counting from zero), and the facts a
// parent asks about it.
class HeldTurn {
    readonly controller = new AbortController();
    private readonly frames: AgentEvent[] = [];
    private readonly sizes: number[] = [];
    private base = 0;
    private bytes = 0;
    // How many frames the parent said it has (`ack`): where a parent that lost its own count (a restart) reads on from.
    acked = 0;
    sawDone = false;
    finishedAt: number | undefined;
    private wakers: (() => void)[] = [];
    private markFinished: () => void = () => undefined;
    readonly finished = new Promise<void>((resolve) => {
        this.markFinished = resolve;
    });

    constructor(
        readonly startedAt: number,
        private readonly budgetBytes: number,
    ) {}

    get count(): number {
        return this.base + this.frames.length;
    }

    get live(): boolean {
        return this.finishedAt === undefined;
    }

    append(event: AgentEvent): void {
        const size = sizeOf(event);
        this.frames.push(event);
        this.sizes.push(size);
        this.bytes += size;
        if (event.kind === "done") {
            this.sawDone = true;
        }
        // Always keeps the newest frame, whatever its size.
        while (this.bytes > this.budgetBytes && this.frames.length > 1) {
            this.frames.shift();
            this.bytes -= this.sizes.shift() ?? 0;
            this.base += 1;
        }
        this.wake();
    }

    finish(at: number): void {
        // Every held turn ends with `done`, so a follower always learns it is over.
        if (!this.sawDone) {
            this.append({ kind: "done" });
        }
        this.finishedAt = at;
        this.wake();
        this.markFinished();
    }

    // Frame number `index`, or a notice standing for the ones let go before it; `next` is where to read on.
    private at(index: number): FrameRead {
        const event = index < this.base ? undefined : this.frames[index - this.base];
        return event === undefined ? { event: droppedNotice(this.base - index), next: this.base } : { event, next: index + 1 };
    }

    async *follow(after: number): AsyncGenerator<AgentEvent> {
        let next = after;
        for (;;) {
            while (next < this.count) {
                const { event, next: following } = this.at(next);
                next = following;
                yield event;
            }
            if (!this.live) {
                return;
            }
            await new Promise<void>((resolve) => {
                this.wakers.push(resolve);
            });
        }
    }

    private wake(): void {
        const waiting = this.wakers;
        this.wakers = [];
        for (const resolve of waiting) {
            resolve();
        }
    }
}

export interface RemoteTurns {
    // Starts the conversation's turn and follows it from its first frame; undefined while one is still running there,
    // which is left untouched.
    readonly start: (conversationId: string, run: (signal: AbortSignal) => AsyncIterable<AgentEvent>) => AsyncGenerator<AgentEvent> | undefined;
    // The held turn's frames after the first `after`, then live until it ends; undefined when none is held.
    readonly follow: (conversationId: string, after: number) => AsyncGenerator<AgentEvent> | undefined;
    readonly held: (conversationId: string) => RunnerHeldTurn;
    readonly ack: (conversationId: string, after: number) => void;
    // Aborts the running turn; false when none runs.
    readonly interrupt: (conversationId: string) => boolean;
    // Waits (bounded) for a turn that said `done` to finish unwinding; at once for anything else.
    readonly settle: (conversationId: string, timeoutMs?: number) => Promise<void>;
    // Its branch went back to the parent: a finished turn is let go; a running one is not finished being delivered.
    readonly delivered: (conversationId: string) => void;
    // Turns running now, for the invariant that compares the board's running cards with live turns.
    readonly live: () => readonly { readonly conversationId: string; readonly startedAt: number }[];
}

export interface RemoteTurnsOptions {
    readonly now?: () => number;
    readonly budgetBytes?: number;
    readonly retainedMs?: number;
}

// Not awaited, and read by nobody in particular: the turn runs to its end whether or not a parent follows it.
const pump = (held: HeldTurn, run: (signal: AbortSignal) => AsyncIterable<AgentEvent>, now: () => number): void => {
    void (async () => {
        try {
            for await (const event of run(held.controller.signal)) {
                held.append(event);
            }
        } catch (error) {
            held.append({ kind: "error", message: `The turn failed on the runner: ${errorMessage(error)}` });
        } finally {
            held.finish(now());
        }
    })();
};

const settled = async (held: HeldTurn, timeoutMs: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        held.finished,
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        }),
    ]);
    clearTimeout(timer);
};

export const createRemoteTurns = ({ now = Date.now, budgetBytes = HELD_TURN_BUDGET_BYTES, retainedMs = HELD_TURN_RETAINED_MS }: RemoteTurnsOptions = {}): RemoteTurns => {
    const turns = new Map<string, HeldTurn>();
    // Lazily, on every door that reads: a finished turn nobody collected is dropped a day after it ended.
    const lookup = (conversationId: string): HeldTurn | undefined => {
        const held = turns.get(conversationId);
        if (held?.finishedAt !== undefined && now() - held.finishedAt > retainedMs) {
            turns.delete(conversationId);
            return undefined;
        }
        return held;
    };
    return {
        start: (conversationId, run) => {
            for (const id of turns.keys()) {
                lookup(id);
            }
            if (lookup(conversationId)?.live === true) {
                return undefined;
            }
            const held = new HeldTurn(now(), budgetBytes);
            turns.set(conversationId, held);
            pump(held, run, now);
            return held.follow(0);
        },
        follow: (conversationId, after) => lookup(conversationId)?.follow(after),
        held: (conversationId) => {
            const held = lookup(conversationId);
            return held === undefined
                ? { state: "none", events: 0, acked: 0 }
                : { state: held.live ? "live" : "finished", events: held.count, acked: held.acked };
        },
        ack: (conversationId, after) => {
            const held = lookup(conversationId);
            if (held !== undefined) {
                held.acked = Math.max(held.acked, Math.min(after, held.count));
            }
        },
        interrupt: (conversationId) => {
            const held = lookup(conversationId);
            if (held?.live !== true) {
                return false;
            }
            held.controller.abort();
            return true;
        },
        settle: async (conversationId, timeoutMs = SETTLE_MS) => {
            const held = lookup(conversationId);
            if (held?.live === true && held.sawDone) {
                await settled(held, timeoutMs);
            }
        },
        delivered: (conversationId) => {
            if (lookup(conversationId)?.live === false) {
                turns.delete(conversationId);
            }
        },
        live: () => [...turns.entries()].filter(([, held]) => held.live).map(([conversationId, held]) => ({ conversationId, startedAt: held.startedAt })),
    };
};
