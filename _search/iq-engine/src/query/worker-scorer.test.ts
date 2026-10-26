import { EventEmitter } from "node:events";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { QueryWorkerRequest } from "./query-worker.js";
import { workerScorer } from "./worker-scorer.js";

class QueryThreadFake extends EventEmitter {
    readonly requests: QueryWorkerRequest[] = [];
    ended = 0;
    postMessage(request: QueryWorkerRequest): void { this.requests.push(request); }
    answer(): void {
        const request = this.requests.shift()!;
        this.emit("message", { type: "semantic", id: request.id, hits: [], pending: 0 });
    }
    async terminate(): Promise<number> { this.ended += 1; this.emit("exit"); return 0; }
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("models start on demand, release after idle, and respawn without stale events affecting requests", async () => {
    const threads: QueryThreadFake[] = [];
    const scorer = workerScorer({ indexDir: "unused", modelDir: undefined, idleMs: 1000, pressureIdleMs: 200,
        underPressure: async () => false, spawn: () => { const thread = new QueryThreadFake(); threads.push(thread); return thread; } });
    expect(scorer.metrics()).toEqual({ live: false, pendingRequests: 0 });
    const first = scorer.semantic("first", new Set());
    threads[0]!.answer();
    expect(await first).toEqual({ hits: [], pending: 0 });
    await advanceTimersByTimeAsync(1000);
    expect(scorer.metrics()).toEqual({ live: false, pendingRequests: 0 });
    expect(threads[0]!.ended).toBe(1);
    const second = scorer.semantic("second", new Set());
    threads[0]!.emit("error", new Error("late error from terminated worker"));
    expect(scorer.metrics()).toEqual({ live: true, pendingRequests: 1 });
    await advanceTimersByTimeAsync(2000);
    expect(threads[1]!.ended).toBe(0);
    threads[1]!.answer();
    expect(await second).toEqual({ hits: [], pending: 0 });
    await scorer.close();
});

test("pressure uses a shorter quiet period and closing settles pending queries", async () => {
    const thread = new QueryThreadFake();
    const scorer = workerScorer({ indexDir: "unused", modelDir: undefined, idleMs: 1000, pressureIdleMs: 200,
        underPressure: async () => true, spawn: () => thread });
    const query = scorer.semantic("first", new Set());
    thread.answer();
    await query;
    await advanceTimersByTimeAsync(199);
    expect(thread.ended).toBe(0);
    await advanceTimersByTimeAsync(1);
    expect(thread.ended).toBe(1);
    const pending = scorer.semantic("second", new Set());
    await scorer.close();
    expect(await pending).toBeUndefined();
    expect(scorer.metrics()).toEqual({ live: false, pendingRequests: 0 });
});

test("a pressure check already in flight cannot release a newly busy worker", async () => {
    const thread = new QueryThreadFake();
    let pressureReady = (_value: boolean): void => {};
    const pressure = new Promise<boolean>((resolve) => { pressureReady = resolve; });
    const scorer = workerScorer({ indexDir: "unused", modelDir: undefined, idleMs: 1000, pressureIdleMs: 200,
        underPressure: () => pressure, spawn: () => thread });
    const first = scorer.semantic("first", new Set());
    thread.answer();
    await first;
    await advanceTimersByTimeAsync(200);
    const second = scorer.semantic("second", new Set());
    pressureReady(true);
    await advanceTimersByTimeAsync(0);
    expect(thread.ended).toBe(0);
    expect(scorer.metrics()).toEqual({ live: true, pendingRequests: 1 });
    thread.answer();
    expect(await second).toEqual({ hits: [], pending: 0 });
    await scorer.close();
});
