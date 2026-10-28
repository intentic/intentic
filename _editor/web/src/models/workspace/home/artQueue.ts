import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { measuredProtocol, streamCapacity } from "../../../lib/streamBudget";

// The home's pictures, fetched a few at a time and never while the reader is flinging past them, as a file manager
// loads its thumbnails: a tile asks once it comes near the viewport (useTileArt.ts), its ask waits here, and a tile that
// scrolls out of reach before its turn takes its ask back. Asking at once for every tile a fling crossed sent a request,
// and on the daemon a picture's encode, for hundreds of pictures nobody stopped to see, and over a link that does not
// multiplex they held every connection the rest of the page needed.

// How long the scroll must rest before the waiting tiles are fetched: long enough to span the gaps inside one fling.
export const SETTLE_MS = 150;
// At once over a link that multiplexes; two leave the explorer, the chat and the menus room on one that does not.
const AT_ONCE = 12;
const AT_ONCE_HTTP1 = 2;

interface Ask {
    // Fetches the picture and paints it; settles once the tile has what it asked for, or knows it will not get it.
    readonly start: () => Promise<void>;
}

const waiting: Ask[] = [];
let running = 0;
// Set by a scroll, cleared once it has rested SETTLE_MS: a flag the settle timer clears, not a clock compared, so the
// rest is measured by the same timer that ends it.
let scrolling = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

const atOnce = (): number => {
    const { daemonBase, usingLocal, degradedTransport } = useEndpoint();
    const kind = degradedTransport.value ? `local-insecure` : usingLocal.value ? `local` : `public`;
    return streamCapacity(kind, measuredProtocol(daemonBase.value)) === Number.POSITIVE_INFINITY ? AT_ONCE : AT_ONCE_HTTP1;
};

const drain = (): void => {
    if (scrolling) {
        return;
    }
    const limit = atOnce();
    while (running < limit && waiting.length > 0) {
        // Newest first: the tiles that came into reach last are the ones on screen when the scroll stopped.
        const ask = waiting.pop();
        if (ask === undefined) {
            break;
        }
        running += 1;
        // A start settles once its tile has an answer or a failure (useTileArt.ts handles both), so this never rejects.
        void ask.start().finally(() => {
            running -= 1;
            drain();
        });
    }
};

/** Holds every fetch back until the scroll has rested; called for any scroll in the window. */
export const noteScroll = (): void => {
    scrolling = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
        scrolling = false;
        drain();
    }, SETTLE_MS);
};

/** Queues a picture's fetch; the answer takes it back while it still waits, and does nothing once it has started. */
export const queueArt = (start: () => Promise<void>): (() => void) => {
    const ask: Ask = { start };
    waiting.push(ask);
    drain();
    return () => {
        const at = waiting.indexOf(ask);
        if (at !== -1) {
            waiting.splice(at, 1);
        }
    };
};

/** How many asks wait and how many are out, for a test. */
export const artQueueState = () => ({ waiting: waiting.length, running });

// Scroll events do not bubble, but the window sees every one of them on the way down.
globalThis.addEventListener?.(`scroll`, () => noteScroll(), { capture: true, passive: true });
