import type { BrowserContext, CDPSession, Page } from "playwright";

// Where a page's viewport is on its X display: the rectangle the picture grabs (videocast.ts) and the origin pointer
// coordinates are added to (live-view.ts). Read off the page, never assumed: the toolbar's height moves with Chromium
// versions and the device scale factor, and a popup window wears a different chrome from a tab's.

// Device pixels on the display; `scale` is device pixels per CSS pixel, what maps a CSS-px still onto the picture.
export interface Region {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
}

// What the page reports about its own window, in CSS px: the window's origin on the screen, its outer and inner
// (viewport) size, and the scale factor. `outer − inner` is the chrome, drawn above the viewport and nowhere else.
export interface WindowGeometry {
    readonly screenX: number;
    readonly screenY: number;
    readonly outerWidth: number;
    readonly outerHeight: number;
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly dpr: number;
}

export interface Screen {
    readonly width: number;
    readonly height: number;
}

// Window bounds as CDP's Browser domain takes them: CSS px, origin at the screen's top-left.
export interface WindowBounds {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

// Narrower than this and a page lays out as a phone; the client never asks for less.
export const MIN_VIEWPORT = 320;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
// libx264 refuses an odd width or height in yuv420p, so a region is always even, shrunk by a pixel where it isn't.
const even = (value: number): number => value - (value % 2);

const scaleOf = (geometry: WindowGeometry): number => (Number.isFinite(geometry.dpr) && geometry.dpr > 0 ? geometry.dpr : 1);

// The viewport rectangle on the display, clamped to the screen: a window hanging off an edge has no pixels there to
// grab.
export const regionOf = (geometry: WindowGeometry, screen: Screen): Region => {
    const scale = scaleOf(geometry);
    const chromeHeight = Math.max(0, geometry.outerHeight - geometry.innerHeight);
    const x = clamp(Math.round(geometry.screenX * scale), 0, screen.width - 2);
    const y = clamp(Math.round((geometry.screenY + chromeHeight) * scale), 0, screen.height - 2);
    const width = clamp(Math.round(geometry.innerWidth * scale), 2, screen.width - x);
    const height = clamp(Math.round(geometry.innerHeight * scale), 2, screen.height - y);
    return { x, y, width: even(width), height: even(height), scale };
};

export const regionsEqual = (left: Region, right: Region): boolean =>
    left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height && left.scale === right.scale;

// Window bounds giving a viewport of `viewport` CSS px, anchored to the screen's bottom-right corner: Chromium flips a
// menu that would leave the screen, so a window whose right and bottom edges are the screen's keeps every <select>
// and context menu inside the viewport being grabbed. Capped at the screen, since nothing beyond it can be grabbed.
export const windowBoundsFor = (viewport: { readonly width: number; readonly height: number }, geometry: WindowGeometry, screen: Screen): WindowBounds => {
    const scale = scaleOf(geometry);
    const screenWidth = Math.floor(screen.width / scale);
    const screenHeight = Math.floor(screen.height / scale);
    const chromeWidth = Math.max(0, geometry.outerWidth - geometry.innerWidth);
    const chromeHeight = Math.max(0, geometry.outerHeight - geometry.innerHeight);
    const width = clamp(Math.round(viewport.width) + chromeWidth, MIN_VIEWPORT + chromeWidth, screenWidth);
    const height = clamp(Math.round(viewport.height) + chromeHeight, MIN_VIEWPORT + chromeHeight, screenHeight);
    return { left: screenWidth - width, top: screenHeight - height, width, height };
};

// Reads the geometry off the page itself. Undefined mid-navigation or once the page is gone; the caller keeps what it
// had.
export const readGeometry = async (page: Page): Promise<WindowGeometry | undefined> =>
    page
        .evaluate(() => ({
            screenX: window.screenX,
            screenY: window.screenY,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            dpr: window.devicePixelRatio,
        }))
        .catch(() => undefined);

export const readRegion = async (page: Page, screen: Screen): Promise<{ readonly region: Region; readonly geometry: WindowGeometry } | undefined> => {
    const geometry = await readGeometry(page);
    return geometry === undefined ? undefined : { region: regionOf(geometry, screen), geometry };
};

// Applies bounds to the window the session's page lives in. Chromium applies them asynchronously; a geometry read
// straight after may still be the old one, which is why callers re-read on a delay.
export const resizeWindow = async (session: CDPSession, bounds: WindowBounds): Promise<void> => {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { ...bounds, windowState: "normal" } });
};

// A window a page opened (window.open with features) lands wherever Chromium puts it on a display with no window
// manager, at whatever size it asked for: placed over its opener's window instead, so it shows as a sheet over the
// page and is grabbed where the viewer is looking. A page with no opener is a tab, already in a placed window.
export const placeWindow = async (context: BrowserContext, page: Page): Promise<void> => {
    const opener = await page.opener().catch(() => null);
    if (opener === null) {
        return;
    }
    const [own, over] = await Promise.all([context.newCDPSession(page), context.newCDPSession(opener)]);
    try {
        const [mine, theirs] = await Promise.all([own.send("Browser.getWindowForTarget"), over.send("Browser.getWindowForTarget")]);
        if (mine.windowId === theirs.windowId) {
            return;
        }
        // CDP types every bound as optional; a window always has all four.
        const { left = 0, top = 0, width = MIN_VIEWPORT, height = MIN_VIEWPORT } = theirs.bounds;
        await own.send("Browser.setWindowBounds", { windowId: mine.windowId, bounds: { left, top, width, height, windowState: "normal" } });
    } finally {
        await Promise.all([own.detach().catch(() => undefined), over.detach().catch(() => undefined)]);
    }
};
