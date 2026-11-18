import { nextSeq, streamWindow, watchWindow, windowChanged, windowWatched } from "./window-feed.js";

describe("a browser window's changes, told to whoever watches it", () => {
    test("seq only rises, and starts at the clock so a restarted daemon's is still the higher", () => {
        const before = Date.now();
        const first = nextSeq();
        const second = nextSeq();
        expect(first).toBeGreaterThanOrEqual(before);
        expect(second).toBeGreaterThan(first);
    });

    test("a change raises the window's seq and reaches its watchers until they stop", () => {
        const window = { name: "browser-feed1", seq: 0 };
        const heard: number[] = [];
        const stop = watchWindow(window.name, () => heard.push(window.seq));
        expect(windowWatched(window.name)).toBe(true);
        windowChanged(window);
        windowChanged(window, true);
        stop();
        windowChanged(window);
        expect(heard).toHaveLength(2);
        const [first = 0, second = 0] = heard;
        expect(second).toBeGreaterThan(first);
        expect(windowWatched(window.name)).toBe(false);
    });

    test("a socket gets the window at once, then a burst of changes as one send, never the same seq twice", async () => {
        const window = { name: "browser-feed2", seq: nextSeq() };
        const sent: number[] = [];
        const stop = streamWindow(
            window.name,
            () => ({ seq: window.seq }),
            (copy) => sent.push(copy.seq),
            30,
        );
        try {
            expect(sent).toEqual([window.seq]);
            windowChanged(window);
            windowChanged(window);
            windowChanged(window);
            // Inside the window after the first send: held, then sent once, as it stands then.
            expect(sent).toHaveLength(1);
            const twice = (): boolean => sent.length >= 2;
            for (let waited = 0; waited < 2_000 && !twice(); waited += 10) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(sent).toHaveLength(2);
            expect(sent.at(-1)).toBe(window.seq);
        } finally {
            stop();
        }
        windowChanged(window);
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(sent).toHaveLength(2);
    });

    test("a window that is gone is not sent", () => {
        const sent: unknown[] = [];
        const stop = streamWindow("browser-feed3", () => undefined, (copy) => sent.push(copy));
        stop();
        expect(sent).toEqual([]);
    });
});
