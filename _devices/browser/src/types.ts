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
    readonly screenshot: () => Promise<Buffer>;
    readonly tabs: () => Promise<{ readonly id: string; readonly title: string; readonly url: string; readonly active: boolean }[]>;
    readonly selectTab: (id: string) => Promise<PageState>;
    // Lets go of the connection; does not close the user's browser, which may predate this agent attaching to it.
    readonly disconnect: () => Promise<void>;
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
