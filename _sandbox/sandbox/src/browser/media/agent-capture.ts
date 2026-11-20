import { mkdir, writeFile } from "node:fs/promises";
import { withTimeout } from "@intentic/base/async";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import sharp from "sharp";
import { z } from "zod";
import { type Display, displayOf } from "../cast/display.js";
import { readRegion, type Region } from "../cast/region.js";
import { browserAccountPage } from "../sessions/browser-sessions.js";
import type { CastControl, CropRect } from "./castd-control.js";
import { type Castd, castdOf } from "./castd.js";

/* What an agent's browser tools take from castd when the window has one (browser-router.ts asks): its screenshots and
   its pauses. The screenshot is castd's picture of the window, the pixels a viewer sees: Chromium's own popups, a
   <select>'s menu, autofill and context menus and a JavaScript dialog included, and nothing re-rendered for it, so it
   sets off no echo of its own in the picture. A pause asked as a bare `time` ends once the screen changed and then
   held still, measured on castd's pixels, instead of always running out.

   Only a shot of the viewport is castd's, and only while the page the agent drives is the tab Chromium shows: a person
   watching may have picked another tab, and the screen then shows theirs, so the shot is @playwright/mcp's, of the
   agent's own page. An element's, or a full page's (the parts scrolled out of view), is not on any screen, and stays
   @playwright/mcp's. A window with no castd (nobody has watched it with the media path, or the sandbox has no castd)
   answers both the old way, through its backend. */

// What browser_take_screenshot takes (@playwright/mcp 0.0.83 screenshot.ts), as far as this reads it.
const ShotArgsSchema = z.looseObject({
    type: z.enum(["png", "jpeg", "webp"]).optional(),
    filename: z.string().optional(),
    fullPage: z.boolean().optional(),
    scale: z.enum(["css", "device"]).optional(),
    element: z.string().optional(),
    ref: z.string().optional(),
    target: z.unknown().optional(),
});

export interface ShotAsked {
    readonly type: "png" | "jpeg" | "webp";
    // Absolute: the router placed it in the output directory (browser-artifacts.ts) before this reads it.
    readonly filename: string | undefined;
    readonly scale: "css" | "device";
}

const EXTENSIONS = new Map<string, ShotAsked["type"]>([
    [".png", "png"],
    [".jpg", "jpeg"],
    [".jpeg", "jpeg"],
    [".webp", "webp"],
]);

// The viewport shot a call asks for, or undefined for one castd cannot take (an element, the full page).
export const viewportShotOf = (params: RpcMessage["params"]): ShotAsked | undefined => {
    const parsed = ShotArgsSchema.safeParse(params?.["arguments"] ?? {});
    if (!parsed.success) {
        return undefined;
    }
    const { type, filename, fullPage, scale, element, ref, target } = parsed.data;
    if (fullPage === true || element !== undefined || ref !== undefined || target !== undefined) {
        return undefined;
    }
    const extension = filename === undefined ? undefined : filename.slice(filename.lastIndexOf(".")).toLowerCase();
    return { type: type ?? (extension === undefined ? undefined : EXTENSIONS.get(extension)) ?? "png", filename, scale: scale ?? "css" };
};

// What a castd capture reaches: the owner's castd, display and the tab in front of its window, each a seam for tests.
export interface CaptureSeams {
    // Whether the page is the tab in front, the one the screen shows.
    readonly inFront: (page: Page) => Promise<boolean>;
    readonly castd: (owner: string) => Pick<Castd, "control" | "framing" | "moveCrop"> | undefined;
    readonly display: (owner: string) => Display | undefined;
    readonly page: (owner: string) => Page | undefined;
    readonly region: (page: Page, display: Display) => Promise<Region | undefined>;
    readonly now: () => Date;
    readonly write: (file: string, bytes: Uint8Array) => Promise<void>;
}

// How long the page may take to say whether it is shown; a page too busy to answer is left to @playwright/mcp.
const VISIBILITY_MS = 1_000;

// A background tab is `hidden` to its own document: Chromium tells a page when it stops being the one shown.
const visibleNow = async (page: Page): Promise<boolean> =>
    // allow(silent-catch): a page closed, navigating or too busy to answer is not one the screen can be trusted to show.
    (await withTimeout(page.evaluate(() => document.visibilityState), VISIBILITY_MS).catch(() => undefined)) === "visible";

export const captureSeams: CaptureSeams = {
    inFront: visibleNow,
    castd: castdOf,
    display: displayOf,
    page: browserAccountPage,
    region: async (page, display) => (await readRegion(page, { width: display.width, height: display.height }))?.region,
    now: () => new Date(),
    write: async (file, bytes) => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes);
    },
};

const rectOf = (region: Region): CropRect => ({ x: region.x, y: region.y, width: region.width, height: region.height });

// The window's picture as castd has it now, with its pixel ratio. A cropped castd (an agent's window) is moved onto the
// front tab's viewport first: its crop follows a viewer's view, and nobody may be watching.
const capture = async (owner: string, seams: CaptureSeams): Promise<{ readonly png: Buffer; readonly scale: number } | undefined> => {
    const castd = seams.castd(owner);
    const display = seams.display(owner);
    const page = seams.page(owner);
    if (castd === undefined || display === undefined || page === undefined || !(await seams.inFront(page))) {
        return undefined;
    }
    let scale = 1;
    if (castd.framing().kind === "crop") {
        const region = await seams.region(page, display);
        if (region === undefined) {
            return undefined;
        }
        await castd.moveCrop(rectOf(region));
        scale = region.scale;
    } else {
        scale = (await castd.control.geometry())?.scale ?? 1;
    }
    const shot = await castd.control.screenshot();
    return shot === undefined ? undefined : { png: shot.png, scale };
};

// The picture as the call asked for it: at CSS pixels unless it asked for the device's, in its format.
const encoded = async (png: Buffer, scale: number, asked: ShotAsked): Promise<{ readonly bytes: Buffer; readonly width: number; readonly height: number }> => {
    let image = sharp(png);
    const meta = await image.metadata();
    let width = meta.width ?? 0;
    let height = meta.height ?? 0;
    if (asked.scale === "css" && scale !== 1 && width > 0 && height > 0) {
        width = Math.max(1, Math.round(width / scale));
        height = Math.max(1, Math.round(height / scale));
        image = image.resize(width, height);
    }
    const bytes = asked.type === "jpeg" ? await image.jpeg({ quality: 90 }).toBuffer() : asked.type === "webp" ? await image.webp().toBuffer() : await image.png().toBuffer();
    return { bytes, width, height };
};

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const satisfies Record<ShotAsked["type"], string>;

// A tool result as @playwright/mcp words a screenshot's: a markdown link to the file it wrote, which the router's
// provenance and the chat's image chip read (screenshot-provenance.ts, browser-artifacts.ts), and the picture itself
// when the call named no file. Plus a line saying where the pixels came from.
export interface ShotResult {
    readonly content: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string })[];
}

/** The viewport screenshot castd takes for `owner`'s window, written where the call asked; undefined to leave it to the backend. */
export const castdScreenshot = async (owner: string, params: RpcMessage["params"], outputDir: string, seams: CaptureSeams = captureSeams): Promise<ShotResult | undefined> => {
    const asked = viewportShotOf(params);
    const captured = asked === undefined ? undefined : await capture(owner, seams);
    if (asked === undefined || captured === undefined) {
        return undefined;
    }
    const picture = await encoded(captured.png, captured.scale, asked);
    const file = asked.filename ?? join(outputDir, `page-${seams.now().toISOString().replaceAll(":", "-")}.${asked.type === "jpeg" ? "jpeg" : asked.type}`);
    await seams.write(file, picture.bytes);
    const said =
        `### Result\n- [Screenshot of viewport](${file})\n\nTaken off the window's screen as a person watching it sees it (castd): ` +
        `${picture.width}×${picture.height} ${asked.scale === "css" ? "CSS" : "device"} pixels, Chromium's own popups, menus and dialogs included.`;
    const text = { type: "text" as const, text: said };
    return { content: asked.filename === undefined ? [text, { type: "image", data: picture.bytes.toString("base64"), mimeType: MIME[asked.type] }] : [text] };
};

// How long the screen must hold still after a change to count as settled: past @playwright/mcp's own 350 ms pause
// after an action (browser-tools.ts), so a debounced menu has drawn.
const QUIET_MS = 500;

// A bare `time` pause, timed on the window's pixels: it ends once the screen has changed and then held still for
// QUIET_MS, and runs out as before when nothing changes or nothing stops changing. Never shorter than asked unless the
// screen changed: a page that reacts on a timer, quiet until then, is still waited for. Undefined leaves it to the
// backend, as a window with no castd.
export const castdPause = async (control: Pick<CastControl, "wait"> | undefined, seconds: number, now: () => number = Date.now): Promise<ShotResult | undefined> => {
    if (control === undefined) {
        return undefined;
    }
    const asked = seconds * 1000;
    const started = now();
    const first = await control.wait({ change: true, timeoutMs: asked });
    if (first === undefined) {
        return undefined;
    }
    if (!first.changed) {
        return { content: [{ type: "text", text: `### Result\nWaited ${seconds}s. Nothing on the window's screen changed meanwhile.` }] };
    }
    const quiet = await control.wait({ quietMs: QUIET_MS, timeoutMs: Math.max(0, asked - (now() - started)) });
    const waited = ((now() - started) / 1000).toFixed(1);
    const text =
        quiet !== undefined && !quiet.timed_out
            ? `### Result\nWaited ${waited}s of the ${seconds}s asked: the window's screen changed, then held still for ${QUIET_MS / 1000}s.`
            : `### Result\nWaited ${seconds}s. The window's screen was still changing when the time ran out.`;
    return { content: [{ type: "text", text }] };
};

/** castd's control for `owner`'s window when it has one, for a pause. */
export const castdControlOf = (owner: string, seams: Pick<CaptureSeams, "castd"> = captureSeams): Pick<CastControl, "wait"> | undefined => seams.castd(owner)?.control;
