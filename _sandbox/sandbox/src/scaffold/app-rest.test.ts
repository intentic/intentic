import { pino } from "pino";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { startAppRest, type AppRestDeps } from "./app-rest.js";

const logger = pino({ level: "silent" });

// A workspace with two listed apps, both running, and a roster whose listeners can be told somebody arrived.
const workspace = (): AppRestDeps & {
    people: number;
    up: Set<string>;
    stopped: string[];
    started: string[][];
    arrive: () => void;
} => {
    const listeners = new Set<() => void>();
    const state = {
        people: 0,
        up: new Set(["site--landing", "site--docs"]),
        stopped: [] as string[],
        started: [] as string[][],
    };
    return Object.assign(state, {
        connected: () => state.people,
        subscribeConnected: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        listed: () => Promise.resolve(["site--landing", "site--docs"]),
        running: (key: string) => state.up.has(key),
        stop: (key: string) => {
            state.stopped.push(key);
            state.up.delete(key);
        },
        start: (keys: ReadonlySet<string>) => {
            state.started.push([...keys].toSorted());
            for (const key of keys) {
                state.up.add(key);
            }
            return Promise.resolve();
        },
        logger,
        arrive: () => {
            state.people += 1;
            for (const listener of listeners) {
                listener();
            }
        },
    });
};

const minutes = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
        await advanceTimersByTimeAsync(60 * 1000);
    }
};

describe("startAppRest", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it("rests every listed app once nobody has been around for the whole window", async () => {
        const box = workspace();
        const rest = startAppRest(box, { idleMs: 15 * 60_000 });
        await minutes(14);
        expect(box.stopped).toEqual([]);
        await minutes(1);
        expect(box.stopped.toSorted()).toEqual(["site--docs", "site--landing"]);
        // Once: a rested app is not stopped again on every later pass.
        await minutes(5);
        expect(box.stopped).toHaveLength(2);
        rest.dispose();
    });

    it("rests nothing while an editor is connected, and the window starts over when it leaves", async () => {
        const box = workspace();
        box.people = 1;
        const rest = startAppRest(box, { idleMs: 15 * 60_000 });
        await minutes(30);
        expect(box.stopped).toEqual([]);
        box.people = 0;
        await minutes(14);
        expect(box.stopped).toEqual([]);
        await minutes(1);
        expect(box.stopped).toHaveLength(2);
        rest.dispose();
    });

    it("somebody connecting starts every rested app again, as the list's boot would", async () => {
        const box = workspace();
        const rest = startAppRest(box, { idleMs: 15 * 60_000 });
        await minutes(15);
        expect(rest.rested().size).toBe(2);
        box.arrive();
        expect(box.started).toEqual([["site--docs", "site--landing"]]);
        expect(rest.rested().size).toBe(0);
        rest.dispose();
    });

    it("a visit keeps its own app up, and wakes only that app once it rested", async () => {
        const box = workspace();
        const rest = startAppRest(box, { idleMs: 15 * 60_000 });
        await minutes(10);
        expect(rest.visit("site--landing")).toBe(false);
        await minutes(5);
        // The docs app went unvisited for the whole window; the landing page was looked at five minutes ago.
        expect(box.stopped).toEqual(["site--docs"]);
        await minutes(10);
        expect(box.stopped).toEqual(["site--docs", "site--landing"]);
        expect(rest.visit("site--docs")).toBe(true);
        expect(box.started).toEqual([["site--docs"]]);
        expect([...rest.rested()]).toEqual(["site--landing"]);
        rest.dispose();
    });

    it("an app somebody holds a connection to is in use, even with no editor and no fresh visit", async () => {
        const box = workspace();
        const rest = startAppRest({ ...box, inUse: (key) => Promise.resolve(key === "site--landing") }, { idleMs: 15 * 60_000 });
        await minutes(30);
        expect(box.stopped).toEqual(["site--docs"]);
        rest.dispose();
    });

    it("an app nobody runs is never counted as rested", async () => {
        const box = workspace();
        box.up.delete("site--docs");
        const rest = startAppRest(box, { idleMs: 15 * 60_000 });
        await minutes(15);
        expect(box.stopped).toEqual(["site--landing"]);
        box.arrive();
        // Only what this rested comes back: an app stopped by hand stays stopped.
        expect(box.started).toEqual([["site--landing"]]);
        rest.dispose();
    });
});
