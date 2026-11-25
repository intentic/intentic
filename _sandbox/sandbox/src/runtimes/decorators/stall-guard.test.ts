import { sleep } from "@intentic/base/async";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { stallGuarded } from "./stall-guard.js";

// A loop that shows `before`, then sends nothing until it is stopped or `quietMs` passes, then shows `after`. Stopped,
// it says so the way a vendor loop does: an error of its own, then done.
const loop =
    (before: readonly AgentEvent[], quietMs: number, after: readonly AgentEvent[]) =>
    async function* (request: { readonly signal: AbortSignal }): AsyncGenerator<AgentEvent> {
        yield* before;
        await sleep(quietMs, { signal: request.signal }).catch(() => undefined);
        if (request.signal.aborted) {
            yield { kind: "error", message: "Claude Code process aborted by user" };
            yield { kind: "done" };
            return;
        }
        yield* after;
        yield { kind: "done" };
    };

const collect = async (events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const seen: AgentEvent[] = [];
    for await (const event of events) {
        seen.push(event);
    }
    return seen;
};

const said = (why: string): string => `The loop stopped responding: ${why}.`;
const WINDOW = { silenceMs: 50, said };
const running: AgentEvent = { kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress" };
const finished: AgentEvent = { kind: "tool_call_update", id: "t1", status: "completed" };

test("a loop silent past the window with nothing open is stopped, and the turn ends on the watchdog's frame", async () => {
    // A hang bound: unguarded, the loop sits silent for a minute.
    const events = await collect(stallGuarded({ signal: new AbortController().signal }, loop([{ kind: "delta", text: "hi" }], 60_000, []), WINDOW));
    expect(events).toEqual([
        { kind: "delta", text: "hi" },
        { kind: "error", code: "provider-outage", message: expect.stringContaining("silence limit"), own: true },
        { kind: "done" },
    ]);
});

test("a tool call still running holds the clock however long it takes", async () => {
    const events = await collect(stallGuarded({ signal: new AbortController().signal }, loop([running], 300, [finished]), WINDOW));
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("a card open on a person holds the clock until it is resolved", async () => {
    const question: AgentEvent = { kind: "question", requestId: "q1", questions: [] };
    const events = await collect(stallGuarded({ signal: new AbortController().signal }, loop([question], 300, [{ kind: "resolved", requestId: "q1" }]), WINDOW));
    expect(events.some((event) => event.kind === "error")).toBe(false);
});

test("silence after the tool finished is a stall again", async () => {
    const events = await collect(stallGuarded({ signal: new AbortController().signal }, loop([running, finished], 60_000, []), WINDOW));
    expect(events.filter((event) => event.kind === "error")).toEqual([expect.objectContaining({ code: "provider-outage" })]);
});

test("a person's stop passes through as the loop says it, with no stall said", async () => {
    const stop = new AbortController();
    const turn = collect(stallGuarded({ signal: stop.signal }, loop([], 60_000, []), { silenceMs: 60_000, said }));
    setTimeout(() => stop.abort(), 20);
    expect(await turn).toEqual([{ kind: "error", message: "Claude Code process aborted by user" }, { kind: "done" }]);
});
