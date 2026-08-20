/* Driving a browser at the level of what is ON the page, rather than where it is on screen.
 *
 * The whole reason this package exists beside @intentic/desktop: a browser can be operated by clicking pixels,
 * and it is miserable. The coordinates move when the window moves, a scroll invalidates every one of them, and
 * "the Submit button" is a guess about which grey rectangle is which. A browser will simply TELL you what it is
 * showing, so ask it, act by reference, and the same instruction works at any window size on any machine.
 *
 * Nothing here knows about agents, scopes or sandboxes. It opens pages and reads and clicks them; whether that
 * is allowed was decided before any of it was called. */

// One thing on the page the agent can act on. `ref` is opaque and only valid until the next snapshot, the page
// may have re-rendered, and a stale reference must fail rather than click whatever now occupies that slot.
export interface PageElement {
    readonly ref: string;
    // What it IS, in the words a person uses: link, button, textbox, checkbox, heading.
    readonly role: string;
    // What it SAYS, its accessible name: the label, the placeholder, the alt text, or its own text.
    readonly name: string;
    // What it currently HOLDS, for anything with a value. Absent for the rest.
    readonly value?: string | undefined;
}

export interface PageState {
    readonly url: string;
    readonly title: string;
    readonly elements: readonly PageElement[];
}

export interface Browser {
    /* Make sure a browser is running and, when given a URL, showing it. Returns the page as it then stands, so
     * the common first step is one call rather than open-then-look. */
    readonly open: (url?: string) => Promise<PageState>;
    // What the page shows right now, with fresh refs. Call it after anything that might have changed the page.
    readonly snapshot: () => Promise<PageState>;
    readonly click: (ref: string) => Promise<void>;
    // Focus the element and enter text. `submit` presses Enter afterwards, the ordinary end of filling a field.
    readonly fill: (ref: string, text: string, submit?: boolean) => Promise<void>;
    // A key for the page as a whole, in @intentic/desktop's vocabulary ("Return", "Escape", "ctrl+f").
    readonly press: (combo: string) => Promise<void>;
    // The page as readable text, what a person would get by selecting all of it, minus the chrome.
    readonly text: () => Promise<string>;
    readonly screenshot: () => Promise<Buffer>;
    readonly tabs: () => Promise<{ readonly id: string; readonly title: string; readonly url: string; readonly active: boolean }[]>;
    readonly selectTab: (id: string) => Promise<PageState>;
    // Let go of the connection. Does NOT close the user's browser, it is theirs, and it may have been open long
    // before this agent attached to it.
    readonly disconnect: () => Promise<void>;
}

/* A browser that could not do the thing, with a sentence naming what would fix it. Same shape as
 * @intentic/desktop's error for the same reason: every caller treats it identically, surface the message, and
 * the alternative is a result type threaded through every method that succeeds in the ordinary case. */
export class BrowserError extends Error {
    readonly hint: string | undefined;
    constructor(message: string, hint?: string) {
        super(message);
        this.name = "BrowserError";
        this.hint = hint;
    }
}
