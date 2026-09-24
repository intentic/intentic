import { NAMED_RENDERS, readingOf } from "./reading.js";
import type { Window } from "./session.js";

const window = (renders: Record<string, number>): Window => ({
    probe: { mounts: { AgentCard: 3, Icon: 12 }, renders, mutations: { records: 5, added: 7, removed: 2 } },
    scripts: [
        { url: "http://127.0.0.1:1/demo/@fs/repo/_editor/web/src/a.ts", functions: [{ ranges: [{ count: 10 }] }] },
        { url: "http://127.0.0.1:1/demo/node_modules/.vite/deps/vue.js", functions: [{ ranges: [{ count: 90 }] }] },
        { url: "http://127.0.0.1:1/demo/src/daemon.ts", functions: [{ ranges: [{ count: 5 }] }] },
        { url: "", functions: [{ ranges: [{ count: 1000 }] }] },
    ],
    layouts: 4,
    styles: 6,
});

describe("readingOf", () => {
    it("totals renders and mounts, and names each component that re-rendered at least the floor", () => {
        const reading = readingOf(window({ ChatPane: 20, RailCard: NAMED_RENDERS, Button: NAMED_RENDERS - 1 }), true);
        expect(reading["vue.renders"]).toBe(20 + NAMED_RENDERS + NAMED_RENDERS - 1);
        expect(reading["vue.mounts"]).toBe(15);
        expect(reading["vue.render:ChatPane"]).toBe(20);
        expect(reading["vue.render:RailCard"]).toBe(NAMED_RENDERS);
        expect(reading["vue.render:Button"]).toBeUndefined();
    });

    it("counts the page's calls without the harness's, and the app's among them", () => {
        const reading = readingOf(window({}), true);
        expect(reading["v8.calls"]).toBe(105);
        expect(reading["v8.calls.app"]).toBe(10);
    });

    it("carries layout, style and mutation counts through unchanged", () => {
        expect(readingOf(window({}), true)).toMatchObject({
            "blink.layouts": 4,
            "blink.styleRecalcs": 6,
            "dom.records": 5,
            "dom.added": 7,
            "dom.removed": 2,
        });
    });

    it("leaves layouts and style recalcs out of a window whose frames wall time decides", () => {
        const reading = readingOf(window({}), false);
        expect(Object.keys(reading).filter((metric) => metric.startsWith("blink."))).toEqual([]);
        expect(reading["dom.records"]).toBe(5);
    });
});
