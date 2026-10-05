import { createHash, randomBytes } from "node:crypto";
import { crop, decodePng, downscale, encodePng } from "./png.js";
import { type Desktop, DesktopError, type Point, type Rect } from "./types.js";

/* What an agent is shown of a screen and how its answers find their way back. A screen is captured at its own
   resolution and shrunk to fit what a model reads whole: past those limits a model API shrinks the image itself,
   says nothing, and every coordinate read off it lands short of where it was aimed. Each image is a frame with an
   id; a point is read in the frame it was taken from and mapped back to desktop pixels here, so a zoomed-in
   region, a 4K monitor and a 1366×768 laptop all answer in the same terms. */

export interface ImageLimits {
    // The longest edge an image may have.
    readonly maxEdge: number;
    // Its area. Claude reads about 1.15 megapixels whole; a 16:9 frame meets the edge first, a 16:10 one the area.
    readonly maxPixels: number;
}

export const MODEL_IMAGE_LIMITS = { maxEdge: 1456, maxPixels: 1_150_000 } satisfies ImageLimits;

// The size a `width`×`height` capture is shown at: shrunk to fit both limits, never enlarged.
export const fitSize = (width: number, height: number, limits: ImageLimits = MODEL_IMAGE_LIMITS) => {
    const scale = Math.min(1, limits.maxEdge / Math.max(width, height), Math.sqrt(limits.maxPixels / (width * height)));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
};

export interface Frame {
    readonly id: string;
    // What was captured, in desktop pixels.
    readonly region: Rect;
    // The image the agent was shown.
    readonly width: number;
    readonly height: number;
    // Of the image's pixels, so an identical screen is recognised whatever the encoder did.
    readonly digest: string;
}

// Desktop pixels per image pixel along each axis; 1 where nothing was shrunk.
const ratio = (frame: Frame) => ({ x: frame.region.width / frame.width, y: frame.region.height / frame.height });

// An image pixel to the desktop pixel at its centre.
export const toDesktop = (frame: Frame, at: Point): Point => {
    if (at.x < 0 || at.y < 0 || at.x >= frame.width || at.y >= frame.height) {
        throw new DesktopError(
            `(${at.x}, ${at.y}) is outside screenshot ${frame.id}, which is ${frame.width}×${frame.height}. Read the coordinates off the image.`,
        );
    }
    const { x, y } = ratio(frame);
    return { x: Math.floor(frame.region.x + (at.x + 0.5) * x), y: Math.floor(frame.region.y + (at.y + 0.5) * y) };
};

// A desktop rectangle as it falls in the image; parts outside the frame are left outside, not clipped.
export const toImage = (frame: Frame, rect: Rect): Rect => {
    const { x, y } = ratio(frame);
    const left = Math.round((rect.x - frame.region.x) / x);
    const top = Math.round((rect.y - frame.region.y) / y);
    return { x: left, y: top, width: Math.max(1, Math.round(rect.width / x)), height: Math.max(1, Math.round(rect.height / y)) };
};

// A rectangle given in a frame's image pixels, as desktop pixels: how a zoom names the part it wants.
export const regionOf = (frame: Frame, rect: Rect): Rect => {
    if (rect.width <= 0 || rect.height <= 0) {
        throw new DesktopError("A region needs a width and a height above zero.");
    }
    const { x, y } = ratio(frame);
    const left = Math.max(frame.region.x, frame.region.x + rect.x * x);
    const top = Math.max(frame.region.y, frame.region.y + rect.y * y);
    const right = Math.min(frame.region.x + frame.region.width, frame.region.x + (rect.x + rect.width) * x);
    const bottom = Math.min(frame.region.y + frame.region.height, frame.region.y + (rect.y + rect.height) * y);
    if (right <= left || bottom <= top) {
        throw new DesktopError(`That region is outside screenshot ${frame.id}, which is ${frame.width}×${frame.height}.`);
    }
    return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
};

const sameRegion = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// How many frames are remembered: enough to name a stale one in a refusal, few enough to hold no images.
const REMEMBERED = 16;

/* The frames one process has shown, newest last. Coordinates are only ever read in the newest: a point read off
   an older image describes a screen that may have moved since, and acting on it is how a click lands on whatever
   took that place. */
export class FrameLog {
    readonly #frames: Frame[] = [];
    // Per process, so a frame id from before a restart cannot match one minted after it.
    readonly #tag = randomBytes(2).toString("hex");
    #counter = 0;
    #unchangedStreak = 0;

    latest(): Frame | undefined {
        return this.#frames.at(-1);
    }

    // The frame a point given against `id` is read in: the newest, refused when `id` names an older one.
    resolve(id: string | undefined): Frame | undefined {
        const latest = this.latest();
        if (id === undefined || id === latest?.id) {
            return latest;
        }
        const known = this.#frames.some((frame) => frame.id === id);
        throw new DesktopError(
            known
                ? `Screenshot ${id} is out of date: the screen was captured again since (${latest?.id ?? "?"}). Read the coordinates off the latest one.`
                : `There is no screenshot ${id} on this device${latest === undefined ? "" : `; the latest is ${latest.id}`}. Take a screenshot first.`,
        );
    }

    // Keeps a newly shown frame; an identical repeat of the newest keeps the newest instead and says so.
    record(region: Rect, width: number, height: number, digest: string) {
        const latest = this.latest();
        if (latest !== undefined && latest.digest === digest && sameRegion(latest.region, region)) {
            this.#unchangedStreak++;
            return { frame: latest, unchanged: true };
        }
        this.#unchangedStreak = 0;
        this.#counter++;
        const frame: Frame = { id: `${this.#tag}-${this.#counter}`, region, width, height, digest };
        this.#frames.push(frame);
        this.#frames.splice(0, Math.max(0, this.#frames.length - REMEMBERED));
        return { frame, unchanged: false };
    }

    // How many captures in a row matched the newest frame.
    unchangedStreak(): number {
        return this.#unchangedStreak;
    }

    // An image was sent after all, so the streak no longer stands between the agent and the pixels.
    sent(): void {
        this.#unchangedStreak = 0;
    }
}

export interface Shot {
    readonly frame: Frame;
    readonly png: Buffer;
    // The screen is pixel-for-pixel what the newest frame already showed.
    readonly unchanged: boolean;
}

// Captures `region` (the whole desktop by default), fits it to `limits`, and records it as a frame.
export const shoot = async (desktop: Desktop, log: FrameLog, region?: Rect, limits: ImageLimits = MODEL_IMAGE_LIMITS): Promise<Shot> => {
    const captured = decodePng(await desktop.capture(region));
    const area: Rect = region ?? { x: 0, y: 0, width: captured.width, height: captured.height };
    // A backend that could not cut the region out itself hands back the whole screen; cut it here.
    const pixels = captured.width === area.width && captured.height === area.height ? captured : crop(captured, area);
    const size = fitSize(pixels.width, pixels.height, limits);
    const shown = downscale(pixels, size.width, size.height);
    const digest = createHash("sha256").update(shown.data).digest("hex");
    const { frame, unchanged } = log.record({ ...area, width: pixels.width, height: pixels.height }, shown.width, shown.height, digest);
    return { frame, png: encodePng(shown), unchanged };
};

// The frame a point is read in when the agent has not been shown one yet: the whole desktop at the size a
// screenshot of it would have. Nothing is captured.
export const defaultFrame = async (desktop: Desktop, limits: ImageLimits = MODEL_IMAGE_LIMITS): Promise<Frame> => {
    const { width, height } = await desktop.frame();
    return { id: "", region: { x: 0, y: 0, width, height }, ...fitSize(width, height, limits), digest: "" };
};
