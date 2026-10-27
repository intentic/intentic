// THE LANDING PAGE'S LIVE HERO. intentic.dev's first screen runs this demo in an iframe it names EMBED_NAME
// (_site/site/src/components/landing/live-demo.ts). A frame's `window.name` outlives its own reloads and navigations,
// so it, not a query parameter the app's router could drop, is what says a page load is the hero's.
//
// Embedded, the demo is a guest on someone else's page, which changes four things, all set up here before any other
// module of the demo or the app runs (main.ts imports this first):
//
// - Its storage is its own. The frame is same-origin and same-tab with /demo/, so it would otherwise read and write the
//   very localStorage and sessionStorage the full demo keeps: its look, its mode, its open tabs, and everything the app
//   remembers as it is clicked through. Both are swapped for in-memory stores seeded with the hero's recording and the
//   site's look, and IndexedDB refuses every open, so every visit opens on the same afternoon, its turns played from
//   the start, and nothing played in the hero follows the visitor to /demo/.
// - It never moves the page around it. The app focuses fields and scrolls rows into view as it mounts, and from a
//   same-origin frame both reach the landing page: a focus would take the keyboard from a reader who never touched the
//   frame, and a scroll would yank the page back up to it. Focus waits for the visitor's first press inside the frame,
//   and the page's scroll position is put back after every scroll the app asks for.
// - The page scrolls through it. The app's root forbids scroll chaining (`overscroll-behavior: none`, there for phones'
//   pull-to-refresh), which inside a frame would leave the landing page stuck while the pointer is over the hero.
// - It says when it has drawn, so the page can swap its poster for the live frame without showing a half-built app.

/** The hero frame's name; live-demo.ts gives its iframe the same one, with LIGHT_SUFFIX on the site's light skin. */
const EMBED_NAME = `intentic-demo-hero`;
const LIGHT_SUFFIX = `:light`;

/** What the frame posts to the page once its first view has drawn; live-demo.ts listens for the same message. */
const READY_MESSAGE = `intentic-demo:ready`;

/** Whether this page load is the landing page's hero. */
export const embedded = window.name === EMBED_NAME || window.name === `${EMBED_NAME}${LIGHT_SUFFIX}`;

// What the hero is: the home view the poster was taken of, in the look the page around it wears, as the screenshots
// take it (_tools/e2e/shots/capture.mts): the site's dark skin is the app in Sanctum, its light one the app unskinned in
// daylight, the Mist wallpaper under both. index.html's pre-paint script reads the same name for the first frame.
const SESSION_SEED = { "intentic.demo.mode": `hero` };
const LOOK = window.name.endsWith(LIGHT_SUFFIX)
    ? { "ui-color-scheme": `light`, "ui-skin": `none`, "ui-wallpaper": `mist` }
    : { "ui-color-scheme": `dark`, "ui-skin": `sanctum`, "ui-wallpaper": `mist` };
// Its turns show their tool calls as they run (models/conversations/tools/useToolCalls.ts): the hero is there to show
// work being done, and folded, a turn reads as a "Thinking…" line beside rows that never appear.
const LOCAL_SEED = { ...LOOK, "ui-chat-show-tool-calls": `on` };

/** A Storage that lives as long as the page: the same methods, kept in a Map. */
const memoryStorage = (seed: Record<string, string>) => {
    const items = new Map(Object.entries(seed));
    return {
        get length(): number {
            return items.size;
        },
        key: (index: number): string | null => [...items.keys()][index] ?? null,
        getItem: (key: string): string | null => items.get(key) ?? null,
        setItem: (key: string, value: string): void => {
            items.set(key, String(value));
        },
        removeItem: (key: string): void => {
            items.delete(key);
        },
        clear: (): void => {
            items.clear();
        },
    };
};

// An IndexedDB request refused as a browser with site storage turned off refuses it: `error` on the next task, nothing
// opened. Every mirror the app keeps there (the transcripts, the query cache, the skeleton imprints) takes its uncached
// path on that answer, so a visit opens on the recording, never on the last visit's copy of a turn that is played again.
class RefusedRequest extends EventTarget {
    readonly result = undefined;
    readonly error = new DOMException(`The landing page's hero keeps nothing between visits.`, `InvalidStateError`);
    readonly readyState = `done`;
    onsuccess: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onblocked: ((event: Event) => void) | null = null;
    onupgradeneeded: ((event: Event) => void) | null = null;

    constructor() {
        super();
        setTimeout(() => {
            const refusal = new Event(`error`);
            this.dispatchEvent(refusal);
            this.onerror?.(refusal);
        });
    }
}

const refusedIndexedDb = {
    open: (): RefusedRequest => new RefusedRequest(),
    deleteDatabase: (): RefusedRequest => new RefusedRequest(),
    databases: async (): Promise<IDBDatabaseInfo[]> => [],
    cmp: (): number => 0,
};

const sealStorage = (): void => {
    Object.defineProperty(window, `localStorage`, { value: memoryStorage(LOCAL_SEED), configurable: true });
    Object.defineProperty(window, `sessionStorage`, { value: memoryStorage(SESSION_SEED), configurable: true });
    Object.defineProperty(window, `indexedDB`, { value: refusedIndexedDb, configurable: true });
};

// Runs `move` and puts the landing page back where it was. Cross-origin parents (somebody else framing /demo/ under this
// name) refuse the read, and there is no page of ours to keep still then.
const keepingPageStill = (move: () => void): void => {
    let page: { x: number; y: number } | undefined;
    try {
        page = window.parent === window ? undefined : { x: window.parent.scrollX, y: window.parent.scrollY };
    } catch {
        // allow(silent-catch): a parent of another origin is not ours to hold still.
        page = undefined;
    }
    move();
    if (page !== undefined) {
        // Instant, and unconditional: a smooth scroll the move began has not moved the page yet, and this cancels it.
        window.parent.scrollTo({ left: page.x, top: page.y, behavior: `instant` });
    }
};

const holdPageStill = (): void => {
    const focus = HTMLElement.prototype.focus;
    const scrollIntoView = Element.prototype.scrollIntoView;
    let engaged = false;
    const engage = (): void => {
        engaged = true;
    };
    // A press, a key, or the keyboard arriving by Tab from the page: each is the visitor's own move into the frame.
    for (const type of [`pointerdown`, `keydown`, `focusin`]) {
        window.addEventListener(type, engage, { capture: true, once: true });
    }
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions): void {
        if (engaged) {
            keepingPageStill(() => focus.call(this, options));
        }
    };
    Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions): void {
        keepingPageStill(() => scrollIntoView.call(this, options));
    };
};

// Unlayered, so it outranks the app's `@layer base` rule without !important.
const letPageScroll = (): void => {
    const style = document.createElement(`style`);
    style.textContent = `html, body { overscroll-behavior: auto; }`;
    document.head.append(style);
};

// Signing out reloads the demo inside the frame rather than loading the site's homepage into its own hero. index.html
// sets `window.env` in a classic script, before any module runs.
const signOutInPlace = (): void => {
    window.env.afterSignOut = import.meta.env.BASE_URL;
};

if (embedded) {
    sealStorage();
    holdPageStill();
    letPageScroll();
    signOutInPlace();
}

// The app marks `boot:view` once its first view has drawn (@intentic/web app/perf/boot.ts). A short settle after it
// lets the view's own reads land, so the swap shows the conversation rather than its placeholder.
const SETTLE_MS = 300;
// A boot that never marks its view (a renamed mark, a view that draws without one) still swaps, a little later.
const FALLBACK_MS = 8_000;

/** Tells the landing page the frame is worth showing; nothing outside the hero. */
export const announceWhenDrawn = (): void => {
    if (!embedded || window.parent === window) {
        return;
    }
    let announced = false;
    const announce = (): void => {
        if (!announced) {
            announced = true;
            window.parent.postMessage(READY_MESSAGE, window.location.origin);
        }
    };
    const settle = (): void => {
        requestAnimationFrame(() => setTimeout(announce, SETTLE_MS));
    };
    const fallback = setTimeout(() => {
        console.warn(`[demo] no boot:view mark after ${FALLBACK_MS} ms; showing the hero anyway`);
        announce();
    }, FALLBACK_MS);
    const drawn = (entries: readonly PerformanceEntry[]): boolean => entries.some((entry) => entry.name === `boot:view`);
    if (drawn(performance.getEntriesByType(`mark`))) {
        clearTimeout(fallback);
        settle();
        return;
    }
    const observer = new PerformanceObserver((list) => {
        if (drawn(list.getEntries())) {
            observer.disconnect();
            clearTimeout(fallback);
            settle();
        }
    });
    observer.observe({ type: `mark` });
};
