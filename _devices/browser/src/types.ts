import type { ConsoleRead } from "./console.js";
import type { FramesOptions, RawFrames } from "./frames.js";
import type { PageState } from "./page.js";

// Drives a browser by what's on the page, not pixel coordinates, which break on scroll/resize; acting by
// reference works at any window size. Knows nothing about agents, scopes, or sandboxes; whether an action is
// allowed is decided before this is called.

export interface Browser {
    // Ensures a browser is running and, given a URL, showing it; returns the page as it then stands.
    readonly open: (url?: string) => Promise<PageState>;
    // What the page shows right now, with fresh refs. Call it after anything that might have changed the page.
    readonly snapshot: () => Promise<PageState>;
    readonly click: (ref: string) => Promise<void>;
    // Focus the element and enter text. `submit` presses Enter afterwards, the ordinary end of filling a field.
    readonly fill: (ref: string, text: string, submit?: boolean) => Promise<void>;
    // A key for the page as a whole, in @intentic/desktop-automation's vocabulary ("Return", "Escape", "ctrl+f").
    readonly press: (combo: string) => Promise<void>;
    // The page as readable text, what a person would get by selecting all of it, minus the chrome.
    readonly text: () => Promise<string>;
    // The visible page, or the visible part of the element `selector` names (a game's canvas), as its GPU composited it.
    readonly screenshot: (selector?: string) => Promise<PageShot>;
    // What the page logged, threw and had the browser log about it, since these tools attached to its tab.
    readonly console: () => Promise<ConsoleRead>;
    // Runs a JavaScript expression in the page, awaiting a promise, within `timeoutMs`; answers its value as JSON text.
    readonly evaluate: (expression: string, timeoutMs: number) => Promise<string>;
    // Times animation frames in the page, after an optional condition, and names the GPU that drew them (frames.ts).
    readonly frames: (options: FramesOptions) => Promise<RawFrames>;
    readonly tabs: () => Promise<{ readonly id: string; readonly title: string; readonly url: string; readonly active: boolean }[]>;
    readonly selectTab: (id: string) => Promise<PageState>;
    // After a click, fill or key: until the DOM goes quiet, or the next document parses when the action navigated,
    // within the 500 ms this used to sleep (settle.ts, 2026-10-20).
    readonly settleAfterAction: () => Promise<void>;
    // Lets go of the connection; does not close the user's browser, which may predate this agent attaching to it.
    readonly disconnect: () => Promise<void>;
}

export interface PageShot {
    readonly png: Buffer;
    // The image's own size in pixels.
    readonly width: number;
    readonly height: number;
    // What it shows: "the visible page", or the element ("canvas#game").
    readonly what: string;
    // The captured area in CSS pixels, and the page's device pixel ratio, so a shrunk image can be read back to the page.
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly devicePixelRatio: number;
}

// A browser call that got no answer within its deadline: told apart by its class, never by its words.
export class BrowserTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BrowserTimeoutError";
    }
}

// A browser action that failed, with a sentence naming what would fix it. Same shape as
// @intentic/desktop-automation's error, so every caller surfaces the message identically.
export class BrowserError extends Error {
    readonly hint: string | undefined;
    constructor(message: string, hint?: string) {
        super(message);
        this.name = "BrowserError";
        this.hint = hint;
    }
}
