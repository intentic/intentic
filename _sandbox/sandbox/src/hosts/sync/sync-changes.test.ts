import { STATE_DIR } from "@intentic/constants";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { batchCarried, createSyncChangeFeed } from "./sync-changes.js";

describe("batchCarried", () => {
    test("a batch of only ignored paths moves nothing: a transcript, a dependency install, a build", () => {
        expect(batchCarried([`${STATE_DIR}/records/sessions/a.jsonl`, "app/node_modules/x/index.js", "app/dist/main.js", "intentic/.git/index"])).toBe(false);
    });

    test("one carried path among them is a change", () => {
        expect(batchCarried(["app/node_modules/x/index.js", "app/src/main.ts"])).toBe(true);
    });

    test("a batch that names nothing is the watcher saying too many to name, which is a change", () => {
        expect(batchCarried([])).toBe(true);
    });
});

describe("createSyncChangeFeed", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("a batch moves the generation once, however many paths it holds", () => {
        const feed = createSyncChangeFeed(undefined, "run");
        feed.batch(["a.ts", "b.ts", "c.ts"]);
        expect(feed.current()).toEqual({ epoch: "run", generation: 1 });
        feed.batch(["node_modules/x"]);
        expect(feed.current().generation).toBe(1);
    });

    test("answers at once for another run's epoch, an unknown generation, or one already behind", async () => {
        const feed = createSyncChangeFeed(undefined, "run");
        feed.batch(["a.ts"]);
        await expect(feed.next(1, "earlier-run", 25_000)).resolves.toEqual({ epoch: "run", generation: 1 });
        await expect(feed.next(undefined, "run", 25_000)).resolves.toEqual({ epoch: "run", generation: 1 });
        await expect(feed.next(0, "run", 25_000)).resolves.toEqual({ epoch: "run", generation: 1 });
    });

    test("holds a caller that is up to date until a carried change, and every holder wakes on the one batch", async () => {
        const feed = createSyncChangeFeed(undefined, "run");
        let first: number | undefined;
        let second: number | undefined;
        void feed.next(0, "run", 25_000).then((answer) => (first = answer.generation));
        void feed.next(0, "run", 25_000).then((answer) => (second = answer.generation));
        feed.batch([`${STATE_DIR}/records/x.jsonl`]);
        await advanceTimersByTimeAsync(1000);
        expect(first).toBeUndefined();
        feed.batch(["src/a.ts"]);
        await advanceTimersByTimeAsync(0);
        expect([first, second]).toEqual([1, 1]);
    });

    test("answers the same generation once the hold runs out, and when the caller goes away", async () => {
        const feed = createSyncChangeFeed(undefined, "run");
        let held: number | undefined;
        void feed.next(0, "run", 25_000).then((answer) => (held = answer.generation));
        await advanceTimersByTimeAsync(24_999);
        expect(held).toBeUndefined();
        await advanceTimersByTimeAsync(1);
        expect(held).toBe(0);
        const gone = new AbortController();
        const pending = feed.next(0, "run", 25_000, gone.signal);
        gone.abort();
        await expect(pending).resolves.toEqual({ epoch: "run", generation: 0 });
    });
});
