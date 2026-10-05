import { randomBytes } from "node:crypto";
import { defaultFrame, type Frame, type FrameLog, regionOf, shoot, type Shot, toDesktop, toImage } from "./frames.js";
import { type Desktop, DesktopError, type DisplayInfo, type Point, type Rect, type UiElement } from "./types.js";

/* What an agent has been shown of a screen, and how its answers are read in the terms it was shown them in:
   screenshots as frames (a point is read in the newest, mapped back to desktop pixels), and a window's controls as
   short refs (an element is found again by the id behind its ref). Shared by every place an agent drives a desktop
   (a person's own machine, the sandbox's virtual one); nothing here decides what is allowed, the tools that call it
   do. A caller keeps one FrameLog and one ElementRefs for as long as its agent's screenshots stay meaningful. */

// How a point the agent gives becomes a desktop pixel: through the frame it was read off, or, for a caller that has
// never been shown one (a test), taken as desktop pixels already and only checked against the screen.
export interface Pointing {
    readonly point: (at: Point, name: string) => Promise<Point>;
    // The centre of an element ref as it stands now, in desktop pixels.
    readonly element: (ref: string) => Promise<Point>;
}

const within = (at: Point, size: { width: number; height: number }, name: string): Point => {
    if (at.x < 0 || at.y < 0 || at.x >= size.width || at.y >= size.height) {
        throw new DesktopError(
            `${name} (${at.x}, ${at.y}) is outside the screen, which is ${size.width}×${size.height}. Take a screenshot and read the coordinates off it.`,
        );
    }
    return at;
};

const centre = (bounds: Rect): Point => ({ x: Math.floor(bounds.x + bounds.width / 2), y: Math.floor(bounds.y + bounds.height / 2) });

// One element ref, as the listing that minted it knew it.
interface ElementRef {
    readonly window: string;
    readonly id: string;
    readonly role: string;
    readonly name: string;
}

/* The refs of the newest element listing, and only those: a ref from an older listing names a control that may have
   gone or moved, so it is refused rather than looked up. Refs carry their listing's two-letter prefix ("kd14"), so an
   old one is told apart from a new one with the same number. */
export class ElementRefs {
    #prefix = "";
    #refs = new Map<string, ElementRef>();

    // Mints refs for `elements` of `window`, replacing every earlier one, and answers them in the same order.
    mint(window: string, elements: readonly UiElement[]): string[] {
        this.#prefix = Array.from(randomBytes(2), (byte) => String.fromCharCode(97 + (byte % 26))).join("");
        this.#refs = new Map();
        return elements.map((element, index) => {
            const ref = `${this.#prefix}${index + 1}`;
            this.#refs.set(ref, { window, id: element.id, role: element.role, name: element.name });
            return ref;
        });
    }

    resolve(ref: string): ElementRef {
        const found = this.#refs.get(ref.trim());
        if (found !== undefined) {
            return found;
        }
        throw new DesktopError(
            this.#prefix !== "" && /^[a-z]{2}\d+$/.test(ref.trim())
                ? `"${ref}" is from an older list of elements, or was never in one. List the window's elements again and use a ref from that list.`
                : `"${ref}" is not an element ref. List a window's elements first (ui_elements) and pass a ref from it, like ${this.#prefix === "" ? "kd3" : `${this.#prefix}3`}.`,
        );
    }
}

// Where an element is right now, in desktop pixels: found again rather than remembered, since a window that scrolled
// or re-laid itself out since the listing has moved it.
export const elementNow = async (screen: Desktop, refs: ElementRefs, ref: string): Promise<{ element: UiElement; described: string }> => {
    const known = refs.resolve(ref);
    const element = await screen.element(known.window, known.id);
    const described = `${known.role} "${known.name}"`;
    if (element === undefined) {
        throw new DesktopError(`The ${described} (${ref}) is no longer in that window. List its elements again.`);
    }
    return { element, described };
};

// The pointing a tool uses: the newest frame (refusing a stale one the call names), or the whole desktop at the size
// a screenshot of it would have when the agent has not been shown one yet. Frame ids are only checked here, where a
// coordinate is read; an element ref carries its own place.
export const pointingFor = (screen: Desktop, log: FrameLog, named: string | undefined, refs: ElementRefs): Pointing => {
    // Read once, on the first coordinate: a call that points only at an element never consults a frame at all.
    let frame: Promise<Frame> | undefined;
    return {
        point: async (at) => toDesktop(await (frame ??= (async () => log.resolve(named) ?? (await defaultFrame(screen)))()), at),
        element: async (ref) => {
            const { element, described } = await elementNow(screen, refs, ref);
            if (element.bounds.width <= 0 || element.bounds.height <= 0) {
                throw new DesktopError(
                    `The ${described} (${ref}) has no place on the screen right now (scrolled away or collapsed). Act on it without the pointer, or scroll it into view first.`,
                );
            }
            return centre(element.bounds);
        },
    };
};

// Desktop pixels as they are: what a caller with no frame means, checked against the screen's own size.
export const desktopPointing = (screen: Desktop, refs: ElementRefs = new ElementRefs()): Pointing => ({
    point: async (at, name) => within(at, await screen.frame(), name),
    element: async (ref) => centre((await elementNow(screen, refs, ref)).element.bounds),
});

// What a screenshot shows: the whole desktop, one display, one window, or a region of the newest frame.
export type ScreenshotTarget =
    | { readonly kind: "desktop" }
    | { readonly kind: "display"; readonly index: number }
    | { readonly kind: "window"; readonly id: string }
    | { readonly kind: "region"; readonly rect: Rect };

const clip = (rect: Rect, size: { width: number; height: number }): Rect => {
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    const right = Math.min(size.width, rect.x + rect.width);
    const bottom = Math.min(size.height, rect.y + rect.height);
    if (right <= x || bottom <= y) {
        throw new DesktopError("That part of the screen is not on any display.");
    }
    return { x, y, width: right - x, height: bottom - y };
};

// The desktop rectangle a target names, and the words that say what it is.
export const regionFor = async (screen: Desktop, log: FrameLog, target: ScreenshotTarget): Promise<{ region: Rect | undefined; what: string }> => {
    switch (target.kind) {
        case "desktop":
            return { region: undefined, what: "the whole desktop" };
        case "display": {
            const displays = await screen.displays();
            const display = displays[target.index - 1];
            if (display === undefined) {
                throw new DesktopError(`There is no display ${target.index}: this device has ${displays.length}.`);
            }
            return { region: display.bounds, what: `display ${target.index}${display.primary ? " (primary)" : ""}` };
        }
        case "window": {
            const window = (await screen.windows()).find((candidate) => candidate.id === target.id);
            if (window === undefined) {
                throw new DesktopError(`There is no window ${target.id} on this device now. List the windows again.`);
            }
            return { region: clip(window.bounds, await screen.frame()), what: `the window "${window.title}" [${window.app}]` };
        }
        case "region": {
            const frame = log.latest() ?? (await defaultFrame(screen));
            return { region: regionOf(frame, target.rect), what: `a region of screenshot ${frame.id === "" ? "of the whole desktop" : frame.id}` };
        }
    }
};

export const describeDisplays = (displays: readonly DisplayInfo[], frame: Frame): string =>
    displays
        .map((display, index) => {
            const at = toImage(frame, display.bounds);
            return `${index + 1}${display.primary ? " (primary)" : ""}: ${display.bounds.width}×${display.bounds.height}, at (${at.x}, ${at.y}) ${at.width}×${at.height} in this image`;
        })
        .join("; ");

// The sentence that goes with a screenshot: what it is, how it maps to the screen, and how to see more of it.
export const describeShot = (shot: Shot, what: string): string => {
    const { frame } = shot;
    const scale = frame.region.width / frame.width;
    const shrunk = scale > 1.001 ? `, shown at 1/${scale.toFixed(2)} of its ${frame.region.width}×${frame.region.height} pixels` : "";
    return (
        `Screenshot ${frame.id}: ${frame.width}×${frame.height}, ${what}${shrunk}. ` +
        `Coordinates you give are pixels in this image; pass frame "${frame.id}" with them so a click is never read off an older one.${ 
        scale > 1.5 ? ` Small text here is hard to read: screenshot a display, a window or a region of this image to see it closer.` : ""}`
    );
};

// A screenshot of the same part of the screen the newest frame showed, as an action's confirming look.
export const reshoot = async (screen: Desktop, log: FrameLog): Promise<Shot> => {
    const latest = log.latest();
    return await shoot(screen, log, latest === undefined || isWholeDesktop(latest, await screen.frame()) ? undefined : latest.region);
};

const isWholeDesktop = (frame: Frame, size: { width: number; height: number }): boolean =>
    frame.region.x === 0 && frame.region.y === 0 && frame.region.width === size.width && frame.region.height === size.height;

// The frame a listing places things in: the newest one, or the whole desktop at screenshot size.
export const viewFrame = async (screen: Desktop, log: FrameLog): Promise<Frame> => log.latest() ?? (await defaultFrame(screen));

export const frameName = (frame: Frame): string => (frame.id === "" ? "a screenshot of the whole desktop" : `screenshot ${frame.id}`);
