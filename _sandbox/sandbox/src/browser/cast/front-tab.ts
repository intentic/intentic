import type { BrowserContext, Page } from "playwright";
import { z } from "zod";

// Which tab a browser's window shows, for a video view that films the display (live-view.ts). A page cannot say:
// Playwright's attach turns on focus emulation for every page it drives, the daemon's and an agent's alike, and that
// keeps each one "visible" whether its tab is in front or not, so `document.visibilityState` reads visible on every tab
// (measured on Chromium 153, 2026-10-08). The view followed the newest of them each second, which pulled the picture
// off the tab the owner had picked onto another tab's still and size: x.com flickering over google.com.
//
// Chromium's DevTools HTTP endpoint knows: /json/list orders pages by when each was last brought in front, the window's
// own tab switches, `Page.bringToFront` and a popup's opening alike, while a navigation or a screenshot in a background
// tab leaves the order alone. CDP's Target.getTargets keeps creation order instead, so it cannot stand in.

// A read that takes longer than this says nothing, and the view keeps what it shows.
const LIST_TIMEOUT_MS = 1000;

const ListedSchema = z.array(z.object({ id: z.string(), type: z.string() }));

// Each page's CDP target id, read once: the key /json/list names a tab by.
const targetIds = new WeakMap<Page, string>();

const targetIdOf = async (context: BrowserContext, page: Page): Promise<string | undefined> => {
    const known = targetIds.get(page);
    if (known !== undefined) {
        return known;
    }
    // allow(silent-catch): a page closing while it is asked about has no tab to be in front.
    const session = await context.newCDPSession(page).catch(() => undefined);
    if (session === undefined) {
        return undefined;
    }
    try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        targetIds.set(page, targetInfo.targetId);
        return targetInfo.targetId;
    } catch {
        // allow(silent-catch): as above, a page gone mid-read.
        return undefined;
    } finally {
        // allow(silent-catch): detaching from a page already gone.
        await session.detach().catch(() => undefined);
    }
};

// Page target ids, most recently in front first; undefined when the endpoint does not answer.
const frontOrder = async (endpoint: string): Promise<string[] | undefined> => {
    try {
        const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
        const parsed = ListedSchema.safeParse(await response.json());
        return parsed.success ? parsed.data.filter((target) => target.type === "page").map((target) => target.id) : undefined;
    } catch {
        // allow(silent-catch): a browser closing or busy answers nothing, and the caller keeps what it shows.
        return undefined;
    }
};

// The tab in front among `context`'s pages, or undefined when that cannot be read (no endpoint, or it did not answer).
// Another context's pages share the list, so the first that is one of this context's is the answer.
export const frontTab = async (context: BrowserContext, endpoint: string | undefined): Promise<Page | undefined> => {
    if (endpoint === undefined) {
        return undefined;
    }
    const order = await frontOrder(endpoint);
    if (order === undefined) {
        return undefined;
    }
    const open = context.pages();
    const ids = await Promise.all(open.map((page) => targetIdOf(context, page)));
    const rank = (index: number): number => {
        const id = ids[index];
        const at = id === undefined ? -1 : order.indexOf(id);
        return at === -1 ? Number.POSITIVE_INFINITY : at;
    };
    let best: Page | undefined;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const [index, page] of open.entries()) {
        if (rank(index) < bestRank) {
            best = page;
            bestRank = rank(index);
        }
    }
    return best;
};
