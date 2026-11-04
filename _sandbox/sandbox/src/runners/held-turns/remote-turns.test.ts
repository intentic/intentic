import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { createRemoteTurns } from "./remote-turns.js";

/* The runner's held turns: a turn outlives whoever follows it, and a follower that comes back reads on from where it was. */

// A turn whose frames are handed in by the test, one at a time, so a test can drop its follower mid-turn.
const scripted = () => {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let aborted = false;
    return {
        say: (event: AgentEvent) => {
            queue.push(event);
            wake?.();
        },
        end: () => {
            ended = true;
            wake?.();
        },
        aborted: () => aborted,
        async *run (signal: AbortSignal): AsyncGenerator<AgentEvent> {
            signal.addEventListener("abort", () => {
                aborted = true;
                ended = true;
                wake?.();
            });
            for (;;) {
                const next = queue.shift();
                if (next !== undefined) {
                    yield next;
                    continue;
                }
                if (ended) {
                    return;
                }
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        },
    };
};

const text = (value: string): AgentEvent => ({ kind: "delta", text: value });

const drain = async (frames: AsyncIterable<AgentEvent> | undefined): Promise<AgentEvent[]> => {
    const seen: AgentEvent[] = [];
    for await (const frame of frames ?? []) {
        seen.push(frame);
    }
    return seen;
};

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a turn runs on after its follower goes, and a re-attach reads on from where the follower stopped", async () => {
    const turns = createRemoteTurns();
    const turn = scripted();
    const first = turns.start("c1", turn.run);
    turn.say(text("a"));
    turn.say(text("b"));
    const head = await first?.next();
    expect(head?.value).toEqual(text("a"));
    // The parent's socket drops: its follower is let go mid-turn.
    await first?.return(undefined);
    turn.say(text("c"));
    turn.say({ kind: "done" });
    turn.end();
    await settle();
    expect(turns.held("c1")).toEqual({ state: "finished", events: 4, acked: 0 });
    expect(await drain(turns.follow("c1", 1))).toEqual([text("b"), text("c"), { kind: "done" }]);
});

test("a re-attach while the turn still runs replays what it missed, then follows live to the end", async () => {
    const turns = createRemoteTurns();
    const turn = scripted();
    void turns.start("c1", turn.run);
    turn.say(text("a"));
    await settle();
    const attached = drain(turns.follow("c1", 0));
    turn.say(text("b"));
    turn.end();
    expect(await attached).toEqual([text("a"), text("b"), { kind: "done" }]);
});

test("nothing held answers none, and follow says so with undefined", () => {
    const turns = createRemoteTurns();
    expect(turns.held("nobody")).toEqual({ state: "none", events: 0, acked: 0 });
    expect(turns.follow("nobody", 0)).toBeUndefined();
});

test("a second start while the turn runs is refused and leaves the running turn's frames alone", async () => {
    const turns = createRemoteTurns();
    const turn = scripted();
    void turns.start("c1", turn.run);
    turn.say(text("a"));
    await settle();
    expect(turns.start("c1", scripted().run)).toBeUndefined();
    turn.end();
    await settle();
    expect(await drain(turns.follow("c1", 0))).toEqual([text("a"), { kind: "done" }]);
});

test("interrupt reaches a turn nobody follows any more", async () => {
    const turns = createRemoteTurns();
    const turn = scripted();
    const first = turns.start("c1", turn.run);
    await first?.return(undefined);
    expect(turns.interrupt("c1")).toBe(true);
    await settle();
    expect(turn.aborted()).toBe(true);
    expect(turns.held("c1").state).toBe("finished");
    expect(turns.interrupt("c1")).toBe(false);
});

test("a turn that throws still ends with an error and done", async () => {
    const turns = createRemoteTurns();
    void turns.start("c1", async function* () {
        yield text("a");
        throw new Error("provider went away");
    });
    await settle();
    const frames = await drain(turns.follow("c1", 0));
    expect(frames.map((frame) => frame.kind)).toEqual(["delta", "error", "done"]);
});

test("delivering a finished turn lets it go; delivering a running one does not", async () => {
    const turns = createRemoteTurns();
    const turn = scripted();
    void turns.start("c1", turn.run);
    turns.delivered("c1");
    expect(turns.held("c1").state).toBe("live");
    turn.end();
    await settle();
    turns.delivered("c1");
    expect(turns.held("c1").state).toBe("none");
});

test("the parent's ack is kept, never past the frames held, never backwards", async () => {
    const turns = createRemoteTurns();
    const turn = scripted();
    void turns.start("c1", turn.run);
    turn.say(text("a"));
    turn.say(text("b"));
    await settle();
    turns.ack("c1", 1);
    turns.ack("c1", 0);
    expect(turns.held("c1").acked).toBe(1);
    turns.ack("c1", 99);
    expect(turns.held("c1").acked).toBe(2);
});

test("a finished turn nobody collects is dropped once its retention passes", async () => {
    let clock = 1_000;
    const turns = createRemoteTurns({ now: () => clock, retainedMs: 100 });
    const turn = scripted();
    void turns.start("c1", turn.run);
    turn.end();
    await settle();
    clock += 50;
    expect(turns.held("c1").state).toBe("finished");
    clock += 100;
    expect(turns.held("c1").state).toBe("none");
});

test("past its byte budget a turn lets its oldest frames go, and a replay from before them says so", async () => {
    const turns = createRemoteTurns({ budgetBytes: 100 });
    const turn = scripted();
    void turns.start("c1", turn.run);
    for (const value of ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"]) {
        turn.say(text(value));
    }
    turn.end();
    await settle();
    const frames = await drain(turns.follow("c1", 0));
    expect(frames[0]?.kind).toBe("agent_notice");
    expect(frames.at(-1)).toEqual({ kind: "done" });
    expect(frames.filter((frame) => frame.kind === "delta").length).toBeLessThan(4);
});

test("settle waits for a turn that said done to finish unwinding", async () => {
    const turns = createRemoteTurns();
    let release: () => void = () => undefined;
    void turns.start("c1", async function* () {
        yield { kind: "done" };
        await new Promise<void>((resolve) => {
            release = resolve;
        });
    });
    await settle();
    expect(turns.held("c1").state).toBe("live");
    const settled = turns.settle("c1", 5_000);
    release();
    await settled;
    expect(turns.held("c1").state).toBe("finished");
});
