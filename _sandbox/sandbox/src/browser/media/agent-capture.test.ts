import sharp from "sharp";
import { unstubbed } from "@intentic/testing";
import type { Page } from "playwright";
import type { Display } from "../cast/display.js";
import type { Region } from "../cast/region.js";
import { type CaptureSeams, castdPause, castdScreenshot, viewportShotOf } from "./agent-capture.js";
import type { CastControl, CastWait, CropRect } from "./castd-control.js";

// An agent's screenshot and pause taken off castd, its control faked: what is taken from castd and what is left to
// @playwright/mcp, the picture at the size and in the format the call asked, and a pause that ends once the screen
// changed and held still.

const DISPLAY: Display = { name: ":120", width: 2560, height: 1600 };
const PAGE = unstubbed<Page>("page", {});
const REGION: Region = { x: 1280, y: 720, width: 40, height: 20, scale: 2 };

// A 40×20 picture as castd sends it: display pixels, red.
const picture = (): Promise<Buffer> => sharp({ create: { width: 40, height: 20, channels: 3, background: "#ff0000" } }).png().toBuffer();

interface Taken {
    readonly crops: CropRect[];
    readonly written: { readonly file: string; readonly bytes: Uint8Array }[];
}

// `unreadable`: the page answers no geometry (mid-navigation, gone). `behind`: the page the agent drives is not the tab
// Chromium shows (a person picked another), so the screen shows another tab.
const seamsOf = async (framing: "crop" | "screen", taken: Taken, region: Region | "unreadable" = REGION, shown: "front" | "behind" = "front"): Promise<CaptureSeams> => {
    const png = await picture();
    return {
        inFront: async () => shown === "front",
        castd: () => ({
            framing: () => (framing === "crop" ? { kind: "crop", rect: { x: 0, y: 0, width: 10, height: 10 } } : { kind: "screen" }),
            moveCrop: async (rect) => {
                taken.crops.push(rect);
            },
            control: unstubbed<CastControl>("control", {
                screenshot: async () => ({ png, seq: 7 }),
                geometry: async () => ({ width: 40, height: 20, scale: 1, screen: { width: 40, height: 20 }, crop: null, resizable: true, pinned: null }),
            }),
        }),
        display: () => DISPLAY,
        page: () => PAGE,
        region: async () => (region === "unreadable" ? undefined : region),
        now: () => new Date("2027-01-15T08:00:00.000Z"),
        write: async (file, bytes) => {
            taken.written.push({ file, bytes });
        },
    };
};

const params = (args: Record<string, unknown>) => ({ name: "browser_take_screenshot", arguments: args });

describe("viewportShotOf", () => {
    test("a viewport shot is castd's, in the format the call or its file name asks, at CSS pixels unless it says device", () => {
        expect(viewportShotOf(params({}))).toEqual({ type: "png", filename: undefined, scale: "css" });
        expect(viewportShotOf(params({ filename: "/out/after.jpg", scale: "device" }))).toEqual({ type: "jpeg", filename: "/out/after.jpg", scale: "device" });
        expect(viewportShotOf(params({ type: "webp", filename: "/out/after.png" }))).toEqual({ type: "webp", filename: "/out/after.png", scale: "css" });
    });

    test("an element's or the full page's is on no screen, and stays @playwright/mcp's", () => {
        expect(viewportShotOf(params({ fullPage: true }))).toBeUndefined();
        expect(viewportShotOf(params({ element: "Submit button", ref: "e12" }))).toBeUndefined();
        expect(viewportShotOf(params({ target: { ref: "e12" } }))).toBeUndefined();
    });
});

describe("castdScreenshot", () => {
    test("a page the agent drives that is not the tab in front is left to @playwright/mcp, never answered with the tab shown", async () => {
        for (const framing of ["crop", "screen"] as const) {
            const taken: Taken = { crops: [], written: [] };
            expect(await castdScreenshot("agent@example.com", params({}), "/out", await seamsOf(framing, taken, REGION, "behind"))).toBeUndefined();
            expect(taken).toEqual({ crops: [], written: [] });
        }
    });

    test("a cropped window's castd is moved onto the front tab's viewport, and its picture comes back at CSS pixels, linked and inline", async () => {
        const taken: Taken = { crops: [], written: [] };
        const answer = await castdScreenshot("agent@example.com", params({}), "/out", await seamsOf("crop", taken));
        expect(taken.crops).toEqual([{ x: 1280, y: 720, width: 40, height: 20 }]);
        expect(taken.written.map((write) => write.file)).toEqual(["/out/page-2027-01-15T08-00-00.000Z.png"]);
        const meta = await sharp(Buffer.from(taken.written[0]?.bytes ?? [])).metadata();
        // Display pixels at a ratio of 2, halved to the page's CSS pixels.
        expect([meta.width, meta.height, meta.format]).toEqual([20, 10, "png"]);
        expect(answer?.content[0]).toEqual({
            type: "text",
            text: expect.stringMatching(/^### Result\n- \[Screenshot of viewport\]\(\/out\/page-2027-01-15T08-00-00\.000Z\.png\)\n\nTaken off the window's screen .* 20×10 CSS pixels/u),
        });
        expect(answer?.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    });

    test("a named file gets the picture at device pixels when asked, in its own format, and no inline copy", async () => {
        const taken: Taken = { crops: [], written: [] };
        const answer = await castdScreenshot("_own", params({ filename: "/out/shot.jpeg", scale: "device" }), "/out", await seamsOf("screen", taken));
        expect(taken.crops).toEqual([]);
        const meta = await sharp(Buffer.from(taken.written[0]?.bytes ?? [])).metadata();
        expect([taken.written[0]?.file, meta.width, meta.height, meta.format]).toEqual(["/out/shot.jpeg", 40, 20, "jpeg"]);
        expect(answer?.content).toHaveLength(1);
    });

    test("a window whose viewport cannot be read, or a call castd cannot take, is left to the backend", async () => {
        const taken: Taken = { crops: [], written: [] };
        expect(await castdScreenshot("agent@example.com", params({}), "/out", await seamsOf("crop", taken, "unreadable"))).toBeUndefined();
        expect(await castdScreenshot("agent@example.com", params({ fullPage: true }), "/out", await seamsOf("crop", taken))).toBeUndefined();
        expect(taken.written).toEqual([]);
    });
});

describe("castdPause", () => {
    // A clock the fake's waits move, and the waits asked of castd in order.
    const control = (answers: readonly (CastWait | undefined)[], clock: { at: number }, asked: string[]): Pick<CastControl, "wait"> => {
        const queue = [...answers];
        return {
            wait: async (asking) => {
                asked.push(asking.change === true ? `change ${asking.timeoutMs}` : `quiet ${asking.quietMs ?? 0} ${asking.timeoutMs}`);
                const answer = queue.shift();
                clock.at += answer?.waited_ms ?? 0;
                return answer;
            },
        };
    };

    test("a screen that changed and held still ends the pause early, said with how long it took", async () => {
        const clock = { at: 0 };
        const asked: string[] = [];
        const said = await castdPause(
            control(
                [
                    { changed: true, timed_out: false, seq: 4, waited_ms: 300 },
                    { changed: false, timed_out: false, seq: 4, waited_ms: 500 },
                ],
                clock,
                asked,
            ),
            5,
            () => clock.at,
        );
        expect(asked).toEqual(["change 5000", "quiet 500 4700"]);
        expect(said?.content).toEqual([{ type: "text", text: "### Result\nWaited 0.8s of the 5s asked: the window's screen changed, then held still for 0.5s." }]);
    });

    test("a screen that never changed is waited out whole, since a page may react on a timer", async () => {
        const clock = { at: 0 };
        const asked: string[] = [];
        const said = await castdPause(control([{ changed: false, timed_out: true, seq: 1, waited_ms: 3000 }], clock, asked), 3, () => clock.at);
        expect(asked).toEqual(["change 3000"]);
        expect(said?.content).toEqual([{ type: "text", text: "### Result\nWaited 3s. Nothing on the window's screen changed meanwhile." }]);
    });

    test("a window with no castd, or a castd that does not answer, pauses the old way", async () => {
        expect(await castdPause(undefined, 2)).toBeUndefined();
        expect(await castdPause(control([undefined], { at: 0 }, []), 2)).toBeUndefined();
    });
});
