import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { z } from "zod";
import { opt } from "../../opt.js";
import { statePath, stateRelPath } from "../../state-paths.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { worthReopening } from "../state/closed-tabs.js";
import { watchWindow } from "../state/window-feed.js";
import { openWindow } from "../state/window-registry.js";
import { browserSessionState } from "../sessions/browser-sessions.js";
import { attachTabHelper, restoreTabs } from "./browser-tabs.js";
import { connectTabHelper } from "./tab-helper.js";

// THE PERSON'S OWN WINDOW, AS IT STOOD: its tabs in strip order, what each was called, its icon, and which was in front,
// written as they change, so the next start of the window (after a daemon restart, a sandbox update, Chromium itself
// ending) reopens them in that order with that tab in front (browser-tabs.ts, restoreTabs). The daemon's own record
// rather than Chromium's: Chromium's Sessions directory is cleared on every start (owner-browser.ts, forgetTabs), since
// its own restore after an unclean exit reopened every tab unasked, beside the one asked for, with the picture on a tab
// the strip had not selected (2026-10-08). This one is deliberate, in order, and the strip agrees with the picture
// because the daemon picks the front tab itself.
//
// Closing the window on purpose (its close, or its last tab) forgets the list: what a person closes stays closed, and
// only an end they did not ask for is undone. Agents' windows are never restored: each belongs to one turn.
//
// Beside the window's profile under .intentic/local/browser/, which never travels in a bundle: neither do the sign-ins
// the tabs would need.

const OwnTabSchema = z.object({
    url: z.string(),
    title: z.string().optional(),
    // The tab's icon as it last showed (a data: URL within page-favicon.ts's cap), so a restored tab that has not
    // loaded yet still shows its site's.
    favicon: z.string().optional(),
});
const OwnTabsSchema = z.object({
    // In the order the strip showed them.
    tabs: z.array(OwnTabSchema),
    // Which of them was in front, as an index into `tabs`.
    front: z.number().int().min(0),
    savedAt: z.number(),
});
export type OwnTabs = z.infer<typeof OwnTabsSchema>;

export const ownTabsDocument = defineDocument({ path: stateRelPath(".intentic/local/browser/", "_own.tabs.json"), schema: OwnTabsSchema });

const ownTabsFile = (root: string) =>
    openDocument(ownTabsDocument, statePath(root, ".intentic/local/browser/", "_own.tabs.json"), {
        fallback: () => ({ tabs: [], front: 0, savedAt: 0 }),
    });

// The most a restore reopens: a window kept open for months is not a reason to start a hundred tabs.
const MAX_TABS = 50;

// The window as the restore keeps it: the tabs that went somewhere (a blank new tab is nothing to bring back), and the
// one in front among them, else the first.
export const ownTabsOf = (window: BrowserSession, savedAt: number): OwnTabs => {
    const kept = window.pages.filter((page) => worthReopening(page.url)).slice(0, MAX_TABS);
    const front = kept.findIndex((page) => page.active);
    return {
        tabs: kept.map((page) => ({ url: page.url, ...opt("title", page.title), ...opt("favicon", page.favicon) })),
        front: Math.max(0, front),
        savedAt,
    };
};

// What a start has to reopen; undefined when nothing was kept.
export const readOwnTabs = async (root: string): Promise<OwnTabs | undefined> => {
    const saved = await ownTabsFile(root).read();
    return saved.tabs.length === 0 ? undefined : { ...saved, front: Math.min(saved.front, saved.tabs.length - 1) };
};

// The window was closed on purpose: its next start opens only what it is asked for.
const forgetOwnTabs = async (root: string): Promise<void> => {
    await ownTabsFile(root).update(() => ({ tabs: [], front: 0, savedAt: Date.now() }));
};

// Where a store's failure is told; the window goes on without what it could not keep.
interface OwnTabsDeps {
    readonly root: string;
    readonly warn: (fields: { readonly err: unknown }, message: string) => void;
}

// The window's own close, which only a close the person asked for reaches (its close, its last tab's): it forgets the
// kept tabs first, so what they closed stays closed.
export const closingForgets =
    (deps: OwnTabsDeps, close: () => Promise<void>): (() => Promise<void>) =>
    async () => {
        try {
            await forgetOwnTabs(deps.root);
        } catch (error) {
            deps.warn({ err: error }, "own browser: could not forget its tabs");
        }
        await close();
    };

// How often the window is written at most: a page loading changes it a dozen times a second.
const SETTLE_MS = 1000;

// Writes the window's tabs within a beat of each change, until the window ends. A window ending (a crash,
// the daemon going down) loses its tabs one by one as Chromium goes, so nothing is written once it has finished: the
// last list written while it ran is the one the next start reopens. Answers how to stop.
const recordOwnTabs = (deps: OwnTabsDeps, name: string): (() => void) => {
    const file = ownTabsFile(deps.root);
    let timer: NodeJS.Timeout | undefined;
    // The list last written, without its time: a change that leaves the tabs as they were writes nothing.
    let written = "";
    let stopped = false;
    const flush = async (): Promise<void> => {
        const window = browserSessionState(name);
        if (stopped) {
            return;
        }
        // The window ended: this recording is over, and the next start begins its own.
        if (window === undefined || !window.running) {
            stop();
            return;
        }
        const tabs = ownTabsOf(window, Date.now());
        const listed = JSON.stringify({ ...tabs, savedAt: 0 });
        if (listed === written) {
            return;
        }
        written = listed;
        try {
            await file.update(() => tabs);
        } catch (error) {
            deps.warn({ err: error }, "own browser: could not keep its tabs");
        }
    };
    // At most once a beat, never starved: a change while a write is pending joins it, so a page that keeps changing
    // (a title ticking, an icon arriving) is still written within the beat.
    const unwatch = watchWindow(name, () => {
        if (timer !== undefined) {
            return;
        }
        timer = setTimeout(() => {
            timer = undefined;
            void flush();
        }, SETTLE_MS);
        timer.unref();
    });
    const stop = (): void => {
        stopped = true;
        clearTimeout(timer);
        unwatch();
    };
    return stop;
};

// A window just adopted, made the person's own: its tab helper connected once its worker is up (not waited for, so a
// Chromium that refuses the extension starts as quickly as one that loads it), its kept tabs reopened, and from then on
// recorded as they change. Answers the tab a restore put in front.
export const resumeOwnTabs = async (deps: OwnTabsDeps, name: string, saved: OwnTabs | undefined): Promise<string | undefined> => {
    const context = openWindow(name)?.context;
    if (context !== undefined) {
        void connectTabHelper(context).then((helper) => attachTabHelper(name, helper));
    }
    const front = saved === undefined ? undefined : await restoreTabs(name, saved);
    recordOwnTabs(deps, name);
    return front;
};
