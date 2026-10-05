import { describeDisplays, describeShot, FrameLog, regionFor, reshoot, shoot } from "@intentic/desktop-automation";
import { fakeDesktop, fakeWindow, FAKE_DISPLAYS } from "../device-testing.js";

/* What a screenshot shows and what an action's confirming look re-captures, over the fake's two side-by-side
   1920×1080 monitors. */

test("a screenshot names a display, a window, or a region of the latest screenshot, as desktop pixels", async () => {
    const fake = fakeDesktop();
    const log = new FrameLog();
    expect(await regionFor(fake.desktop, log, { kind: "display", index: 2 })).toEqual({ region: FAKE_DISPLAYS[1]?.bounds, what: "display 2" });
    await expect(regionFor(fake.desktop, log, { kind: "display", index: 3 })).rejects.toThrow(/no display 3: this device has 2/);
    // A maximised window hangs a few pixels off its monitor; the capture stops at the screen's edge.
    fake.windows = [fakeWindow({ id: "5", title: "Editor", bounds: { x: -8, y: -8, width: 1936, height: 1096 } })];
    expect((await regionFor(fake.desktop, log, { kind: "window", id: "5" })).region).toEqual({ x: 0, y: 0, width: 1928, height: 1080 });
    await expect(regionFor(fake.desktop, log, { kind: "window", id: "6" })).rejects.toThrow(/no window 6/);
    // A region is read in the latest screenshot: the right half of a whole-desktop shot is the second monitor.
    await shoot(fake.desktop, log);
    expect((await regionFor(fake.desktop, log, { kind: "region", rect: { x: 728, y: 0, width: 728, height: 409 } })).region).toEqual({
        x: 1920,
        y: 0,
        width: 1920,
        height: 1080,
    });
});

test("a shot says how it was shrunk and where each display sits in it", async () => {
    const fake = fakeDesktop();
    const shot = await shoot(fake.desktop, new FrameLog());
    expect(describeShot(shot, "the whole desktop")).toMatch(
        new RegExp(`^Screenshot ${shot.frame.id}: 1456×409, the whole desktop, shown at 1/2\\.64 of its 3840×1080 pixels\\..*frame "${shot.frame.id}"`),
    );
    expect(describeDisplays(FAKE_DISPLAYS, shot.frame)).toBe("1 (primary): 1920×1080, at (0, 0) 728×409 in this image; 2: 1920×1080, at (728, 0) 728×409 in this image");
});

test("an action's confirming look re-captures the part of the screen the latest screenshot showed", async () => {
    const fake = fakeDesktop();
    const log = new FrameLog();
    const second = { x: 1920, y: 0, width: 1920, height: 1080 };
    await shoot(fake.desktop, log, second);
    const again = await reshoot(fake.desktop, log);
    expect(again.frame.region).toEqual(second);
    expect(again.unchanged).toBe(true);
    expect(fake.calls).toEqual(["capture 1920,0 1920x1080", "capture 1920,0 1920x1080"]);
});
