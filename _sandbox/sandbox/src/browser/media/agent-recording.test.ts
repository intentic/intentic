import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { Page } from "playwright";
import type { Display } from "../cast/display.js";
import type { Region } from "../cast/region.js";
import { type TurnRecordingDeps, turnBrowsed, turnEnded } from "./agent-recording.js";
import type { CastControl, CropRect } from "./castd-control.js";
import type { CastFraming } from "./castd-process.js";
import { castdRecordDir } from "./castd.js";
import { join } from "node:path";
import { recordingName, turnRecordingPath } from "./recordings.js";

// An agent's turn recorded as it drives a window, castd's control faked: off unless the sandbox says on, one recording
// from the first call with a window, a new part when the window moves (castd ends a recording at a new crop), every part
// kept under the conversation's own folder when the turn ends, and the conversation told where as it starts.

const DISPLAY: Display = { name: ":120", width: 2560, height: 1600 };
const PAGE = unstubbed<Page>("page", {});
const AT = new Date("2027-01-15T08:00:00.000Z");

interface Seen {
    readonly started: number[];
    readonly stopped: number[];
    readonly crops: CropRect[];
    readonly kept: string[];
    readonly notes: string[];
}

const depsOf = (enabled: boolean, regions: Region[], seen: Seen, framing: CastFraming["kind"] = "crop"): TurnRecordingDeps => {
    let next = 1;
    // The file each recording was started with: castd answers its stop with where it wrote it.
    const files = new Map<number, string>();
    const control = unstubbed<CastControl>("control", {
        recordStart: async (file) => {
            seen.started.push(next);
            files.set(next, file);
            return { id: next++, max_seconds: 300 };
        },
        recordStop: async (id) => {
            seen.stopped.push(id);
            return { file: join(castdRecordDir(), files.get(id) ?? ""), bytes: 1024 };
        },
    });
    return {
        enabled: async () => enabled,
        outputDir: "/out/browser",
        note: (conversationId, text) => seen.notes.push(`${conversationId}: ${text}`),
        log: () => undefined,
        castd: (_owner, _display, asked) => ({
            control,
            framing: () => (framing === "crop" ? { kind: "crop", rect: asked } : { kind: "screen" }),
            ready: async () => true,
            moveCrop: async (rect) => {
                seen.crops.push(rect);
            },
        }),
        display: () => DISPLAY,
        page: () => PAGE,
        region: async () => regions.shift() ?? { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
        now: () => AT,
        keep: async (file) => {
            seen.kept.push(file);
        },
    };
};

const fresh = (): Seen => ({ started: [], stopped: [], crops: [], kept: [], notes: [] });

describe("a turn's browsing recorded", () => {
    test("off by default: nothing is started, and nothing is kept at the turn's end", async () => {
        const seen = fresh();
        const deps = depsOf(false, [], seen);
        await turnBrowsed("agent@example.com", "conv-off", deps);
        await turnEnded("conv-off", deps);
        expect(seen).toEqual(fresh());
    });

    test("on, the first call starts one recording, the window moving starts a second part, and the turn's end keeps both", async () => {
        const seen = fresh();
        const first: Region = { x: 1280, y: 720, width: 1280, height: 880, scale: 1 };
        const moved: Region = { x: 1000, y: 600, width: 1560, height: 1000, scale: 1 };
        const deps = depsOf(true, [first, first, moved], seen);
        await turnBrowsed("agent@example.com", "conv-on", deps);
        await turnBrowsed("agent@example.com", "conv-on", deps);
        expect(seen.started).toEqual([1]);
        await turnBrowsed("agent@example.com", "conv-on", deps);
        expect(seen.stopped).toEqual([1]);
        expect(seen.started).toEqual([1, 2]);
        expect(seen.crops).toEqual([
            { x: 1280, y: 720, width: 1280, height: 880 },
            { x: 1000, y: 600, width: 1560, height: 1000 },
        ]);
        await turnEnded("conv-on", deps);
        expect(seen.stopped).toEqual([1, 2]);
        const base = "/out/browser/conv-on/agent@example.com-2027-01-15T08-00-00";
        expect(seen.kept).toEqual([`${base}.mp4`, `${base}-2.mp4`]);
        expect(seen.notes).toEqual([`conv-on: Recording this turn's browsing in agent@example.com's window (recordAgentBrowsing is on): ${base}.mp4 once the turn ends.`]);
    });
});

// A promise the test lets go of: what a slow castd or a slow page read is held on.
interface Gate {
    readonly wait: Promise<void>;
    readonly open: () => void;
}

const gate = (): Gate => {
    let open: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { wait, open };
};

describe("a turn that ends while its recording is still being changed", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test("a recording still starting when the turn ends is kept and stopped, not left running", async () => {
        const seen = fresh();
        const starting = gate();
        const base = depsOf(true, [], seen);
        const deps: TurnRecordingDeps = {
            ...base,
            castd: (owner, display, rect) => {
                const castd = base.castd(owner, display, rect);
                return castd === undefined ? undefined : { ...castd, ready: () => starting.wait.then(() => true) };
            },
        };
        const browsing = turnBrowsed("agent@example.com", "conv-late", deps);
        const ending = turnEnded("conv-late", deps);
        starting.open();
        await Promise.all([browsing, ending]);
        expect(seen.started).toEqual([1]);
        expect(seen.stopped).toEqual([1]);
        expect(seen.kept).toEqual(["/out/browser/conv-late/agent@example.com-2027-01-15T08-00-00.mp4"]);
    });

    test("a part that runs out as the turn ends starts no part after it", async () => {
        jest.useFakeTimers();
        const seen = fresh();
        const reading = gate();
        let reads = 0;
        const deps: TurnRecordingDeps = {
            ...depsOf(true, [], seen),
            // The second call's read of the page is slow: the turn's end, and the part's timer, queue behind it.
            region: async () => {
                reads += 1;
                if (reads === 2) {
                    await reading.wait;
                }
                return { x: 0, y: 0, width: 1280, height: 800, scale: 1 };
            },
        };
        await turnBrowsed("agent@example.com", "conv-timer", deps);
        expect(seen.started).toEqual([1]);
        const browsing = turnBrowsed("agent@example.com", "conv-timer", deps);
        const ending = turnEnded("conv-timer", deps);
        // castd's longest (300 s) less the daemon's margin: the part's own stop comes due behind the turn's end.
        await advanceTimersByTimeAsync(300_000);
        reading.open();
        await Promise.all([browsing, ending]);
        await advanceTimersByTimeAsync(0);
        expect(seen.started).toEqual([1]);
        expect(seen.stopped).toEqual([1]);
        // Nothing is armed after the turn: another castd longest passes with no part kept.
        await advanceTimersByTimeAsync(600_000);
        expect(seen.started).toEqual([1]);
        expect(seen.kept).toEqual(["/out/browser/conv-timer/agent@example.com-2027-01-15T08-00-00.mp4"]);
    });
});

describe("a window castd frames as its whole screen", () => {
    test("is recorded as it is: never moved to a crop, which would start castd again under its viewer", async () => {
        const seen = fresh();
        const first: Region = { x: 0, y: 0, width: 1280, height: 880, scale: 1 };
        const resized: Region = { x: 0, y: 0, width: 1600, height: 1000, scale: 1 };
        const deps = depsOf(true, [first, resized], seen, "screen");
        await turnBrowsed("agent@example.com", "conv-screen", deps);
        await turnBrowsed("agent@example.com", "conv-screen", deps);
        await turnEnded("conv-screen", deps);
        expect(seen.crops).toEqual([]);
        expect(seen.started).toEqual([1]);
        expect(seen.stopped).toEqual([1]);
    });
});

describe("a window that cannot be recorded", () => {
    test("is tried once a turn, not on every call, and tried again in the next turn", async () => {
        const seen = fresh();
        const tried: string[] = [];
        const deps: TurnRecordingDeps = {
            ...depsOf(true, [], seen),
            castd: () => {
                tried.push("castd");
                return undefined;
            },
        };
        await turnBrowsed("web", "conv-none", deps);
        await turnBrowsed("web", "conv-none", deps);
        expect(tried).toEqual(["castd"]);
        await turnEnded("conv-none", deps);
        await turnBrowsed("web", "conv-none", deps);
        expect(tried).toEqual(["castd", "castd"]);
        expect(seen.started).toEqual([]);
        await turnEnded("conv-none", deps);
    });
});

describe("recording names", () => {
    test("a window's recording is named by its label and when it started, safe for any file system", () => {
        expect(recordingName("Recording Maps: where/now", AT)).toBe("Recording Maps where now 2027-01-15 08.00.00.mp4");
        expect(recordingName("", AT)).toBe("browser 2027-01-15 08.00.00.mp4");
    });

    test("a turn's parts sit in the conversation's folder, numbered from the second", () => {
        expect(turnRecordingPath("/out", "conv 1", "web", AT, 1)).toBe("/out/conv_1/web-2027-01-15T08-00-00.mp4");
        expect(turnRecordingPath("/out", "conv", "a/b", AT, 3)).toBe("/out/conv/a_b-2027-01-15T08-00-00-3.mp4");
    });
});
