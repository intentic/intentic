import { unstubbed } from "@intentic/testing";
import { defaultFrame, fitSize, type Frame, FrameLog, regionOf, shoot, toDesktop, toImage } from "./frames.js";
import { decodePng, encodePng } from "./png.js";
import { type Desktop, DesktopError, type Rect } from "./types.js";

/* The frame model: how big a screenshot is shown, how a point read off it finds its way back to the screen, and
   when a point is refused because the screen it was read off is no longer the latest. */

test("a capture is shrunk to fit both limits, and never enlarged", () => {
    // Two monitors, a 1920×1200 beside a 4K: the long edge decides.
    expect(fitSize(5760, 2160)).toEqual({ width: 1456, height: 546 });
    // 16:10 meets the area limit before the edge one.
    const wide = fitSize(2560, 1600);
    expect(wide.width * wide.height).toBeLessThanOrEqual(1_150_000);
    expect(wide.width).toBeLessThan(1456);
    expect(fitSize(1366, 768)).toEqual({ width: 1366, height: 768 });
});

const frame = (overrides: Partial<Frame> = {}): Frame => ({
    id: "f1",
    region: { x: 0, y: 0, width: 5760, height: 2160 },
    width: 1456,
    height: 546,
    digest: "",
    ...overrides,
});

test("a point in a shrunk image lands on the desktop pixel at its centre, offset by where the frame starts", () => {
    const whole = frame();
    // 5760/1456 ≈ 3.956 desktop pixels per image pixel.
    expect(toDesktop(whole, { x: 0, y: 0 })).toEqual({ x: 1, y: 1 });
    expect(toDesktop(whole, { x: 1455, y: 545 })).toEqual({ x: 5758, y: 2158 });
    // A frame of the second monitor alone, unscaled: its own pixels plus its origin.
    const display = frame({ region: { x: 1920, y: 0, width: 1280, height: 720 }, width: 1280, height: 720 });
    expect(toDesktop(display, { x: 10, y: 20 })).toEqual({ x: 1930, y: 20 });
    expect(() => toDesktop(display, { x: 1280, y: 5 })).toThrow(/outside screenshot f1, which is 1280×720/);
});

test("a desktop rectangle maps into the image, and a region of the image maps back out, clipped to the frame", () => {
    const whole = frame();
    expect(toImage(whole, { x: 1920, y: 0, width: 3840, height: 2160 })).toEqual({ x: 485, y: 0, width: 971, height: 546 });
    const zoom = regionOf(whole, { x: 485, y: 0, width: 2000, height: 100 });
    expect(zoom.x).toBe(1918);
    expect(zoom.x + zoom.width).toBe(5760);
    expect(() => regionOf(whole, { x: 2000, y: 0, width: 10, height: 10 })).toThrow(/outside screenshot f1/);
    expect(() => regionOf(whole, { x: 0, y: 0, width: 0, height: 10 })).toThrow(DesktopError);
});

test("only the newest frame reads points: an older one is refused by name, an unknown one is refused too", () => {
    const log = new FrameLog();
    const first = log.record({ x: 0, y: 0, width: 100, height: 100 }, 100, 100, "a").frame;
    const second = log.record({ x: 0, y: 0, width: 100, height: 100 }, 100, 100, "b").frame;
    expect(first.id).not.toBe(second.id);
    expect(log.resolve(undefined)).toBe(second);
    expect(log.resolve(second.id)).toBe(second);
    expect(() => log.resolve(first.id)).toThrow(new RegExp(`${first.id} is out of date.*${second.id}`));
    expect(() => log.resolve("nope")).toThrow(/no screenshot nope.*latest is/);
});

test("an identical capture of the same region keeps the newest frame and counts the streak", () => {
    const log = new FrameLog();
    const area = { x: 0, y: 0, width: 10, height: 10 };
    const shown = log.record(area, 10, 10, "same").frame;
    expect(log.record(area, 10, 10, "same")).toEqual({ frame: shown, unchanged: true });
    expect(log.record(area, 10, 10, "same").unchanged).toBe(true);
    expect(log.unchangedStreak()).toBe(2);
    log.sent();
    expect(log.unchangedStreak()).toBe(0);
    // The same pixels of a different part of the screen are a new frame: its coordinates mean something else.
    expect(log.record({ ...area, x: 5 }, 10, 10, "same").unchanged).toBe(false);
});

// A desktop whose screenshot tool cannot cut a region and always hands back the whole screen, as the Linux ones do.
const wholeScreenOnly = (width: number, height: number, shade: () => number): Desktop =>
    unstubbed<Desktop>("desktop", {
        frame: async () => ({ width, height, origin: { x: 0, y: 0 } }),
        capture: async () => encodePng({ width, height, data: new Uint8Array(width * height * 3).fill(shade()) }),
    });

test("a shot is cut to its region when the tool could not, fitted, recorded, and recognised when nothing changed", async () => {
    let shade = 10;
    const desktop = wholeScreenOnly(3000, 1000, () => shade);
    const log = new FrameLog();
    const region: Rect = { x: 1000, y: 0, width: 2000, height: 1000 };
    const shot = await shoot(desktop, log, region);
    expect(shot.frame.region).toEqual(region);
    expect([shot.frame.width, shot.frame.height]).toEqual([fitSize(2000, 1000).width, fitSize(2000, 1000).height]);
    expect(decodePng(shot.png).width).toBe(shot.frame.width);
    expect(shot.unchanged).toBe(false);
    expect((await shoot(desktop, log, region)).unchanged).toBe(true);
    shade = 11;
    expect((await shoot(desktop, log, region)).unchanged).toBe(false);
});

test("with no screenshot yet, points are read as if the whole desktop had been shown", async () => {
    const assumed = await defaultFrame(wholeScreenOnly(5760, 2160, () => 0));
    expect(assumed).toMatchObject({ id: "", region: { x: 0, y: 0, width: 5760, height: 2160 }, width: 1456, height: 546 });
});
