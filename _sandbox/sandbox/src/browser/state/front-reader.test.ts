import { frontReader } from "./front-reader.js";

// A read the test answers by hand, so what happens while one is under way can be pinned.
const manualReads = () => {
    const waiting: ((front: string | undefined) => void)[] = [];
    return {
        read: () => new Promise<string | undefined>((resolve) => waiting.push(resolve)),
        answer: async (front: string | undefined): Promise<void> => {
            waiting.shift()?.(front);
            // Lets the reader's own continuation run before the test looks.
            await new Promise((resolve) => setImmediate(resolve));
        },
        pending: () => waiting.length,
    };
};

describe("which tab a window has in front, asked of Chromium", () => {
    test("an ask while one is under way is asked once more after it, never alongside it", async () => {
        const reads = manualReads();
        const applied: string[] = [];
        const reader = frontReader({ read: reads.read, apply: (front) => applied.push(front), watched: () => false });
        try {
            reader.schedule();
            reader.schedule();
            reader.schedule();
            expect(reads.pending()).toBe(1);
            await reads.answer("p1");
            // The asks that came during the first read could have moved the tab after Chromium answered it.
            expect(reads.pending()).toBe(1);
            await reads.answer("p2");
            expect(reads.pending()).toBe(0);
            expect(applied).toEqual(["p1", "p2"]);
        } finally {
            reader.stop();
        }
    });

    test("no answer leaves the last one standing, and a stopped reader applies nothing", async () => {
        const reads = manualReads();
        const applied: string[] = [];
        const reader = frontReader({ read: reads.read, apply: (front) => applied.push(front), watched: () => false });
        reader.schedule();
        await reads.answer(undefined);
        expect(applied).toEqual([]);
        reader.schedule();
        reader.stop();
        await reads.answer("p3");
        reader.schedule();
        expect(reads.pending()).toBe(0);
        expect(applied).toEqual([]);
    });

    test("a read that throws leaves the last answer standing, and the next ask still runs", async () => {
        let calls = 0;
        const applied: string[] = [];
        const reader = frontReader({
            read: async () => {
                calls += 1;
                if (calls === 1) {
                    throw new Error("the browser went away mid-read");
                }
                return "p2";
            },
            apply: (front) => applied.push(front),
            watched: () => false,
        });
        try {
            reader.schedule();
            await new Promise((resolve) => setImmediate(resolve));
            expect(applied).toEqual([]);
            reader.schedule();
            await new Promise((resolve) => setImmediate(resolve));
            expect(applied).toEqual(["p2"]);
        } finally {
            reader.stop();
        }
    });

    test("the backstop asks only while someone watches the window", async () => {
        let watched = false;
        let reads = 0;
        const reader = frontReader({
            read: async () => {
                reads += 1;
                return "p1";
            },
            apply: () => undefined,
            watched: () => watched,
            backstopMs: 10,
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(reads).toBe(0);
            watched = true;
            const asked = (): boolean => reads > 0;
            for (let waited = 0; waited < 2_000 && !asked(); waited += 10) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(reads).toBeGreaterThan(0);
        } finally {
            reader.stop();
        }
    });
});
