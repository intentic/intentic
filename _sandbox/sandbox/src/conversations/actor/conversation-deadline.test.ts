import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { memoryFleet } from "../../testing.js";
import { deadlineKind, deadlines } from "./conversation-deadline.js";

// One timer per conversation per kind, at the exact instant it is due: set, moved, cleared, gone with the conversation,
// and fired one at a time.

const KIND = deadlineKind("test deadline");

describe("conversation deadlines", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const harness = () => {
        const { conversations } = memoryFleet();
        const failures: string[] = [];
        const due = deadlines(conversations, KIND, (conversationId, error) => failures.push(`${conversationId}: ${error.message}`));
        return { conversations, due, failures };
    };

    test("fire once, at the instant set, and are gone after", async () => {
        const { due } = harness();
        const fired: number[] = [];
        due.set("c1", 1_000 + 50_000, async () => void fired.push(1), 1_000);
        expect(due.at("c1")).toBe(51_000);
        await advanceTimersByTimeAsync(49_999);
        expect(fired).toEqual([]);
        await advanceTimersByTimeAsync(1);
        expect(fired).toEqual([1]);
        expect(due.at("c1")).toBeUndefined();
        await advanceTimersByTimeAsync(100_000);
        expect(fired).toEqual([1]);
    });

    test("a second set moves the one deadline, and a clear takes it", async () => {
        const { due } = harness();
        const fired: string[] = [];
        due.set("c1", 10_000, async () => void fired.push("first"), 0);
        due.set("c1", 20_000, async () => void fired.push("moved"), 0);
        await advanceTimersByTimeAsync(20_000);
        expect(fired).toEqual(["moved"]);
        due.set("c1", 30_000, async () => void fired.push("cleared"), 20_000);
        due.clear("c1");
        await advanceTimersByTimeAsync(30_000);
        expect(fired).toEqual(["moved"]);
    });

    test("leave with the conversation's dispose", async () => {
        const { conversations, due } = harness();
        const fired: string[] = [];
        conversations.send("c1", { kind: "keep-warm-armed", until: 1 });
        due.set("c1", 10_000, async () => void fired.push("c1"), 0);
        await conversations.dispose(["c1"]);
        await advanceTimersByTimeAsync(10_000);
        expect(fired).toEqual([]);
    });

    test("fire one at a time, a failure reported without stopping the next", async () => {
        const { due, failures } = harness();
        const order: string[] = [];
        let release: () => void = () => undefined;
        due.set(
            "c1",
            1_000,
            async () => {
                order.push("c1 start");
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                order.push("c1 end");
                throw new Error("refresh failed");
            },
            0,
        );
        due.set("c2", 1_500, async () => void order.push("c2"), 0);
        await advanceTimersByTimeAsync(1_000);
        expect(order).toEqual(["c1 start"]);
        // c2 falls due while c1 still runs, and waits for it.
        await advanceTimersByTimeAsync(500);
        expect(due.at("c2")).toBeUndefined();
        expect(order).toEqual(["c1 start"]);
        release();
        // The chain's own hops, each a microtask: c1's end, its reported failure, then c2.
        for (let hop = 0; hop < 10; hop++) {
            await Promise.resolve();
        }
        expect(order).toEqual(["c1 start", "c1 end", "c2"]);
        expect(failures).toEqual(["c1: refresh failed"]);
    });
});
