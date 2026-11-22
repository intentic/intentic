import { z } from "zod";
import { desktopApp } from "../../../../app/environments/desktop";
import { activeSandboxId } from "../../../../app/storage/activeSandbox";
import { segmentOf } from "../../../../lib/routes/links";
import { closeTabs, openBeside, type SideInput, sideDocked, tabsOfView } from "../../../../workbench/side/sideTabs";
import { centred, popupFeatures, rememberedFrame } from "../../../../workbench/window/floating";

// WHERE A COMPUTER'S SCREEN CAN BE SHOWN BESIDES ITS FULL PAGE IN DEVICES: a tab of the side panel, which stays beside
// whichever section the rail picks (the screen watched while the reader works elsewhere), and a window of its own (on a
// second monitor, say). Both carry the same four facts, so a screen moved from one place to the next opens on the same
// computer and monitor.

/** The side view a computer's screen is drawn in beside a section (SideDeviceScreen.vue, registered in coreSideViews.ts). */
export const SCREEN_SIDE_VIEW = `device-screen`;

export const ScreenAtSchema = z.object({
    // The machine's key on the Devices view, for its page and "Open in Devices".
    machine: z.string().min(1),
    // The connection whose screen it is (`rog`).
    device: z.string().min(1),
    // The computer, as its page names it: the tab and the window wear it before the device list is read.
    name: z.string(),
    // The monitor picked; absent is the computer's primary one.
    monitor: z.string().min(1).optional(),
});
export type ScreenAt = z.infer<typeof ScreenAtSchema>;

/** Where a screen's toolbar can move it from where it is drawn; each one absent where the move means nothing. */
export interface ScreenMoves {
    // Into a tab of the side panel, beside whichever section is open.
    readonly beside?: () => void;
    // Into a window of its own; false when the browser refused the window, and the screen stays where it is.
    readonly window?: () => boolean;
    // From a window of its own back into the app's window that opened it.
    readonly home?: () => void;
}

// Left out rather than stored empty, so one screen is one tab however it was opened.
export const screenSideInput = (at: ScreenAt): SideInput => {
    const { monitor, ...rest } = at;
    return monitor === undefined ? rest : { ...rest, monitor };
};

/**
 * Opens the screen as a tab beside the section, in place of a tab already showing that computer (on another monitor,
 * say), so one computer is one tab and one stream. False where this window has no side panel (a phone).
 */
export const openScreenBeside = (at: ScreenAt): boolean => {
    if (!sideDocked.value) {
        return false;
    }
    const same = tabsOfView(SCREEN_SIDE_VIEW).find((tab) => tab.input[`device`] === at.device);
    openBeside(SCREEN_SIDE_VIEW, screenSideInput(at), { keep: true, replace: same?.id });
    return true;
};

// A computer's tabs beside the section, once a window of its own shows it: moved, not closed, so Reopen Closed Tab does
// not bring a second stream back.
const leaveBeside = (device: string): void =>
    closeTabs(new Set(tabsOfView(SCREEN_SIDE_VIEW).flatMap((tab) => (tab.input[`device`] === device ? [tab.id] : []))));

// --- A window of its own -------------------------------------------------------------------------------------------

// The toolbar over the picture, in CSS pixels: what the window adds to the picture's own height.
const BAR = 41;
// How much of the screen the window opens on a new window takes at most.
const ROOM = 0.8;
// A window for a computer whose monitor is not known yet: a laptop's screen.
const FALLBACK = { width: 1280, height: 800 };

/** A width and height, in whichever pixels the caller says. */
export interface Size {
    readonly width: number;
    readonly height: number;
}

/**
 * The size a screen's window opens at, in CSS pixels: the monitor's proportions as large as fit in most of the screen it
 * opens on, with the toolbar over it, so the picture fills it with no bars at its sides. Pure, for the suite.
 */
export const screenWindowSize = (monitor: Size | undefined, room: Size): Size => {
    const most = { width: room.width * ROOM, height: room.height * ROOM };
    const ratio = monitor === undefined || monitor.width <= 0 || monitor.height <= 0 ? FALLBACK.width / FALLBACK.height : monitor.width / monitor.height;
    const width = Math.min(most.width, (most.height - BAR) * ratio);
    return { width: Math.round(width), height: Math.round(width / ratio + BAR) };
};

/** Where a computer's screen window was left, kept per computer: on a second monitor, it opens there again. */
export const screenFrameKey = (device: string): string => `intentic.screen.frame.${device}`;

// A window per computer, so pressing again on the same one raises it rather than opening a second stream.
const windowName = (device: string): string => `intentic-screen-${device.replaceAll(/[^A-Za-z0-9_-]/gu, `-`)}`;

// The address the window opens at. `/floating/screen`, under no sandbox, since that is the one shape the desktop app's
// new-window handler builds a window of its own for (windows/hosted.rs `floating_panel`); the route puts the sandbox
// back in the path (router/index.ts).
const openingAddress = (at: ScreenAt, sandbox: string): string => {
    const query = new URLSearchParams({ sandbox: segmentOf(sandbox), ...screenSideInput(at) });
    return `${import.meta.env.BASE_URL}floating/screen?${query.toString()}`;
};

// The windows this one opened, still open: a second press raises the one it has.
const opened = new Map<string, Window>();

// In the desktop app every screen window is one window of the app's (it labels a floating window by its panel), which a
// second open only raises: told here which computer to show instead.
const channel = globalThis.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.screen-window`);

const ScreenWindowNoteSchema = z.object({ kind: z.literal(`show`), at: ScreenAtSchema });

/** Runs `show` whenever the main window asks this desktop app's one screen window to show another computer. */
export const onScreenWindowNote = (show: (at: ScreenAt) => void): (() => void) => {
    const heard = (event: MessageEvent<unknown>): void => {
        const note = ScreenWindowNoteSchema.safeParse(event.data).data;
        if (note !== undefined) {
            show(note.at);
        }
    };
    channel?.addEventListener(`message`, heard);
    return () => channel?.removeEventListener(`message`, heard);
};

/**
 * Opens the screen in a window of its own, or raises the one already showing that computer, and takes that computer's
 * tab from beside the section: one place, one stream. `monitor` is its size, for the window's. False only when the
 * browser's popup blocker refused the window: the screen stays where it is.
 */
export const openScreenWindow = (at: ScreenAt, monitor?: Size): boolean => {
    const sandbox = activeSandboxId.value;
    if (sandbox === undefined) {
        return false;
    }
    const held = opened.get(at.device);
    if (held !== undefined && !held.closed) {
        held.focus();
        leaveBeside(at.device);
        return true;
    }
    const frame = rememberedFrame(screenFrameKey(at.device)) ?? centred(screenWindowSize(monitor, { width: window.screen.availWidth, height: window.screen.availHeight }));
    const win = window.open(openingAddress(at, sandbox), windowName(at.device), popupFeatures(frame));
    if (desktopApp() !== undefined) {
        // The app answers with a window of its own and hands the page null, as a blocker would.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
        channel?.postMessage({ kind: `show`, at } satisfies z.infer<typeof ScreenWindowNoteSchema>);
        leaveBeside(at.device);
        return true;
    }
    if (win === null) {
        return false;
    }
    opened.set(at.device, win);
    win.focus();
    leaveBeside(at.device);
    return true;
};

// --- Back from a window of its own ---------------------------------------------------------------------------------

// What a screen's window says to the window that opened it, to take the screen back onto its full page there.
const HOME_KIND = `intentic.screen.home`;
const HomeNoteSchema = z.object({ kind: z.literal(HOME_KIND), at: ScreenAtSchema });

/** The window that opened this one, while it is still the app's and still open: where "Bring back" sends the screen. */
export const openerWindow = (): Window | undefined => {
    try {
        // SAFETY: `window.opener` is typed `any`; it is a window or null, and every use below is guarded by the reads that
        // throw or answer false for anything else.
        const opener = window.opener as Window | null;
        // Reading its origin throws for another site's window, which is no window of the app's.
        return opener !== null && !opener.closed && opener.location.origin === window.location.origin ? opener : undefined;
    } catch {
        // allow(silent-catch): the throw is the answer itself: a window of another site, which is no window of the app's to hand anything to.
        return undefined;
    }
};

/** Hands the screen back to the window that opened this one; false when there is none to take it. */
export const sendScreenHome = (at: ScreenAt): boolean => {
    const opener = openerWindow();
    if (opener === undefined) {
        return false;
    }
    opener.postMessage({ kind: HOME_KIND, at } satisfies z.infer<typeof HomeNoteSchema>, window.location.origin);
    opener.focus();
    return true;
};

/** Runs `show` whenever one of this window's screen windows hands its screen back; returns the way to stop listening. */
export const onScreenHome = (show: (at: ScreenAt) => void): (() => void) => {
    const heard = (event: MessageEvent<unknown>): void => {
        if (event.origin !== window.location.origin) {
            return;
        }
        const note = HomeNoteSchema.safeParse(event.data).data;
        if (note !== undefined) {
            show(note.at);
        }
    };
    window.addEventListener(`message`, heard);
    return () => window.removeEventListener(`message`, heard);
};
