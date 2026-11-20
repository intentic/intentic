import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { browserSessionName } from "@intentic/sandbox-contract/session-names";
import type { BrowserContext, Page } from "playwright";
import { noteClosed } from "../state/closed-tabs.js";
import { wakeDeferred } from "../state/deferred-tabs.js";
import { pageTargetId, watchFavicon } from "../state/page-favicon.js";
import { browserWindows } from "../state/window-registry.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { releaseDisplay } from "../cast/display.js";
import { placeWindow } from "../cast/region.js";
import { armPasskeys } from "../tools/passkeys.js";
import { freshNavigation, navigationCommitted, watchLoading, watchNavigation } from "../navigation/page-navigation.js";
import { type FrontReader, frontReader } from "../state/front-reader.js";
import { frontTab } from "../state/front-tab.js";
import { historyOf } from "../state/page-history.js";
import { noteBrowsing } from "../history/browsing-feed.js";
import { nextSeq, windowChanged, windowWatched } from "../state/window-feed.js";
import type { BrowserSessionRecord, PageRecord } from "../state/window-record.js";
import { summarizeWindow } from "../state/window-summary.js";
import { armPageTools } from "../permissions/arm-page.js";

// Makes the agent's browser (launched and owned by @playwright/mcp) visible to the daemon: it attaches over CDP the
// first time a browser tool is called, without taking over Chromium's lifecycle.
// Sessions are named `browser-<id8>` and track every open page, not just the newest, since a browser can hold several
// tabs at once.
// browserSessionPage turns a page id from a `bind` frame back into a Page the screencast can point at.

// Chromium's cold-launch attach window; generous for a slow container start.
const ATTACH_TIMEOUT_MS = 45_000;
const ATTACH_POLL_MS = 250;

// How long a new tab's id is waited for after the tab itself exists; see browserSessionNewTab.
const TAB_ID_TICKS = 10;
const TAB_ID_TICK_MS = 25;

// How long a finished session stays listable, matching terminal-session.ts's retention window.
const RETAIN_FINISHED_MS = 2 * 3_600_000;

// A tab that just opened is taken to be in front at once, as Chromium puts it there; Chromium is asked again this much
// later, once it lists the tab, for one opened behind (a Ctrl+click).
const OPENED_TAB_SETTLE_MS = 150;

const sessions = browserWindows;
const consumers = new WeakMap<BrowserSessionRecord, number>();
const unused = (record: BrowserSessionRecord): boolean => record.help === undefined && (consumers.get(record) ?? 0) === 0;

// A visible stream or an in-flight tool owns a browser until it finishes, even across the shorter pressure window.
export const holdBrowserSession = (name: string): (() => void) => {
    const record = sessions.get(name);
    if (record === undefined) {return () => {};}
    consumers.set(record, (consumers.get(record) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) {return;}
        released = true;
        consumers.set(record, Math.max(0, (consumers.get(record) ?? 1) - 1));
        record.activityAt = Date.now();
    };
};

// No background sweep; every list call prunes expired sessions first.
const prune = (now: number): void => {
    for (const [name, record] of sessions) {
        if (record.finishedAt !== undefined && record.finishedAt <= now - RETAIN_FINISHED_MS) {
            sessions.delete(name);
            publishRuntimeChange("browsers");
        }
    }
};

// Server segment of a browser tool's name, e.g. `mcp__web__browser_navigate` to `web`.
// For the routed server this only says a browser tool was called; ownerOfBrowserCall resolves which browser via the
// call's `account`.
export const browserServerOfTool = (tool: string): string | undefined => {
    const match = /^mcp__(.+)__browser_/.exec(tool);
    return match?.[1];
};

// A tab a restore left unloaded loads once it is in front, whoever put it there (deferred-tabs.ts).
const bringForward = (record: BrowserSessionRecord, pageId: string): void => {
    record.activePageId = pageId;
    record.lastPageId = pageId;
    wakeDeferred(record.pages.get(pageId));
};

// The window's reader of which tab is in front (front-reader.ts), for a browser with a DevTools port to ask.
const readerFor = (record: BrowserSessionRecord, context: BrowserContext): FrontReader | undefined => {
    if (record.port <= 0) {
        return undefined;
    }
    const endpoint = `http://127.0.0.1:${record.port}`;
    return frontReader({
        read: async () => {
            const picks = record.picks;
            const page = await frontTab(context, endpoint);
            // A tab picked while Chromium was being asked is in front now, whatever the answer says.
            return record.picks === picks ? [...record.pages.values()].find((entry) => entry.page === page && !entry.closed)?.id : undefined;
        },
        apply: (pageId) => {
            if (record.activePageId !== pageId && record.finishedAt === undefined) {
                bringForward(record, pageId);
                windowChanged(record, true);
            }
        },
        watched: () => windowWatched(record.name),
    });
};

// Records a page's current url, title and history. Which tab is in front is the reader's to say; a window without one
// (no DevTools port to ask) takes the tab last driven for it.
// Title is optional: a page mid-navigation may have a url but not yet a title.
const notePage = async (record: BrowserSessionRecord, entry: PageRecord): Promise<void> => {
    record.activityAt = Date.now();
    if (record.front === undefined || record.activePageId === undefined) {
        bringForward(record, entry.id);
    }
    entry.url = entry.page.url();
    await readTitle(entry);
    // Where the window's profile has been, for the address bar's suggestions (history/browsing-feed.ts).
    noteBrowsing(record.server, entry);
    entry.history = entry.cdp === undefined ? entry.history : ((await historyOf(entry.cdp)) ?? entry.history);
    // Rate-limited on the bus, not here.
    windowChanged(record);
};

// Throws if the page navigated away mid-read; the next event retries. An empty title counts as no title. A read that
// lands while a navigation is in flight is Playwright's placeholder ("Loading <url>"), not the page's own, and is
// dropped: the page coming to rest reads it again (navigationMoved).
const readTitle = async (entry: PageRecord): Promise<void> => {
    const title = await entry.page.title().catch(() => undefined);
    if (entry.navigation.pending === undefined) {
        entry.title = title === undefined || title === "" ? undefined : title;
    }
};

// A tab setting off, arriving or failing is what a viewer is watching for, so it goes out within the milestone window
// rather than the domain's second. Come to rest (stopped, failed, loaded), it reads its title again, the one a read on
// the way could not have.
const navigationMoved = (record: BrowserSessionRecord, entry: PageRecord): void => {
    windowChanged(record, true);
    if (!entry.navigation.loading && entry.navigation.pending === undefined) {
        void readTitle(entry).then(() => windowChanged(record));
    }
};

// The page's own DevTools session, for what Playwright says nothing about after the fact: a dialog closing, by whichever
// hand (the owner's answer over the view, or the agent's browser_handle_dialog), and Chromium's own loading flag.
const watchPageSession = async (record: BrowserSessionRecord, context: BrowserContext, entry: PageRecord): Promise<void> => {
    const session = await context.newCDPSession(entry.page).catch(() => undefined);
    if (session === undefined) {
        return;
    }
    entry.cdp = session;
    session.on("Page.javascriptDialogClosed", () => {
        if (entry.dialog !== undefined) {
            entry.dialog = undefined;
            windowChanged(record);
        }
    });
    entry.page.once("close", () => void session.detach().catch(() => undefined));
    await session.send("Page.enable").catch(() => undefined);
    // allow(silent-catch): its file chooser and permission asks (permissions/arm-page.ts); a page closing has none left.
    void armPageTools(record, entry.page, entry.id, session, () => windowChanged(record, true)).catch(() => undefined);
    await watchLoading(session, entry.navigation, () => navigationMoved(record, entry));
    // Its target id, which the tab helper's sound is keyed by (window-summary.ts): read now, so the tab is listed with its
    // sound from here on rather than once something else asks for the id.
    await pageTargetId(entry);
    // What arrived before this session opened has a history already.
    entry.history = (await historyOf(session)) ?? entry.history;
    windowChanged(record);
};

const watchPage = (record: BrowserSessionRecord, page: Page): void => {
    const entry: PageRecord = {
        id: `p${record.nextPageId}`,
        page,
        url: page.url(),
        title: undefined,
        closed: false,
        dialog: undefined,
        navigation: freshNavigation(),
        cdp: undefined,
        history: undefined,
    };
    record.nextPageId += 1;
    record.pages.set(entry.id, entry);
    // Opened in front, where Chromium puts a new tab or popup, until Chromium is asked (a Ctrl+click opens one behind).
    bringForward(record, entry.id);
    record.front?.schedule(OPENED_TAB_SETTLE_MS);
    // Unreported: no logger reaches this module (agent.ts and codex-agent.ts open sessions without one).
    if (record.passkeyStore !== undefined && record.context !== undefined) {
        void armPasskeys(record.context, page, record.passkeyStore, () => undefined).catch(() => undefined);
    }
    // Held, never answered here: a Playwright client dismisses any dialog nobody listens for, which is what this
    // daemon's attach did to every alert the agent's page opened, taking browser_handle_dialog with it. The owner
    // answers over the view (answerBrowserDialog), the agent through its tool; Chromium closes it once for both.
    page.on("dialog", (dialog) => {
        entry.dialog = dialog;
        windowChanged(record);
    });
    if (record.context !== undefined) {
        void watchPageSession(record, record.context, entry);
        // A popup lands wherever a display with no window manager puts it; over its opener, where the viewer looks.
        void placeWindow(record.context, page).catch(() => undefined);
    }
    void notePage(record, entry);
    watchFavicon(record, entry);
    watchNavigation(page, entry.navigation, () => navigationMoved(record, entry));
    page.on("framenavigated", (frame) => {
        if (frame.parentFrame() === null) {
            navigationCommitted(entry.navigation, frame.url());
            void notePage(record, entry);
        }
    });
    // SPA titles set post-load; domcontentloaded is the only signal for that.
    page.on("domcontentloaded", () => void notePage(record, entry));
    // Closed tab leaves the strip; active falls back to the newest still-open page until Chromium says which one it put
    // in front. lastPageId is untouched here.
    page.on("close", () => {
        noteClosed(record, entry);
        entry.closed = true;
        if (record.activePageId === entry.id) {
            record.activePageId = [...record.pages.values()].findLast((other) => !other.closed)?.id;
        }
        record.front?.schedule();
        windowChanged(record);
    });
};

// The X display is keyed by server (browser-tools.ts starts one per account owner), and several conversations can
// browse the same account, so it goes only once the last record using it has stopped. Without this nothing ever called
// releaseDisplay: displays accumulated for the daemon's life, and across a restart the adopted ones could not be
// killed at all — measured, 23 X servers alive for 7 live browsers.
const releaseIdleDisplay = (server: string): void => {
    for (const record of sessions.values()) {
        if (record.server === server && record.finishedAt === undefined) {
            return;
        }
    }
    releaseDisplay(server);
};

// Page records stay: a finished session's value is where the agent went. Their Page handles are dead, so
// browserSessionPage refuses any finished session.
// Finishing twice is not finishing again: a second close must not re-settle a help request, and must not release a
// display that a later session has since started on the same account.
const finish = (record: BrowserSessionRecord): void => {
    if (record.finishedAt !== undefined) {
        return;
    }
    record.finishedAt = Date.now();
    record.front?.stop();
    record.front = undefined;
    // Settles any parked help request as not-helped; idempotent against a racing turn-abort settle.
    record.abandonHelp?.("the browser closed before anyone could help");
    record.help = undefined;
    record.abandonHelp = undefined;
    record.browser = undefined;
    record.context = undefined;
    record.attaching = undefined;
    // After finishedAt is stamped, so this record no longer counts itself as a user of its own display.
    releaseIdleDisplay(record.server);
    windowChanged(record);
};

// The help-request flow's state side lives in browser-help.ts, over the same windows.
export { clearBrowserHelp, raiseBrowserHelp } from "./browser-help.js";

// Polls Chromium's DevTools endpoint then attaches over CDP.
// Tolerant of failure: a session that never attaches still lists (unwatchable but real) rather than vanishing.
const attach = async (record: BrowserSessionRecord): Promise<BrowserContext | undefined> => {
    const endpoint = `http://127.0.0.1:${record.port}`;
    const deadline = Date.now() + ATTACH_TIMEOUT_MS;
    const { chromium } = await import("playwright");
    while (Date.now() < deadline && record.finishedAt === undefined) {
        try {
            const browser = await chromium.connectOverCDP(endpoint);
            const context = browser.contexts()[0];
            if (context === undefined) {
                await browser.close();
                return undefined;
            }
            record.browser = browser;
            record.context = context;
            record.front = readerFor(record, context);
            // Chromium disconnecting is the only end signal; the process belongs to the SDK's child tree, not this
            // daemon.
            browser.on("disconnected", () => finish(record));
            context.on("page", (page) => watchPage(record, page));
            for (const page of context.pages()) {
                watchPage(record, page);
            }
            return context;
        } catch {
            // Not listening yet; Chromium is still starting under the tool call that triggered this.
            await sleep(ATTACH_POLL_MS);
        }
    }
    return undefined;
};

// Registers or refreshes the session behind a browser tool call and starts the attach on first sight.
export const openBrowserSession = (input: {
    readonly sessionId: string;
    readonly server: string;
    readonly port: number;
    readonly passkeyStore?: string | undefined;
    readonly owner?: string | undefined;
}): string | undefined => {
    const name = browserSessionName(input.sessionId);
    if (name === undefined) {
        return undefined;
    }
    const existing = sessions.get(name);
    // Same port: same browser, just another call. Different port: a fresh per-turn Chromium; the record is replaced.
    // Another call is also when an agent may have switched tabs (browser_tabs), so Chromium is asked again.
    if (existing !== undefined && existing.port === input.port && existing.finishedAt === undefined) {
        existing.activityAt = Date.now();
        existing.front?.schedule();
        windowChanged(existing);
        return name;
    }
    const record: BrowserSessionRecord = {
        name,
        seq: nextSeq(),
        own: false,
        shutdown: undefined,
        owner: input.owner,
        server: input.server,
        port: input.port,
        passkeyStore: input.passkeyStore,
        startedAt: Date.now(),
        activityAt: Date.now(),
        pages: new Map(),
        nextPageId: 1,
        activePageId: undefined,
        lastPageId: undefined,
        front: undefined,
        finishedAt: undefined,
        help: undefined,
        abandonHelp: undefined,
        browser: undefined,
        context: undefined,
        attaching: undefined,
    };
    sessions.set(name, record);
    // Published immediately so the rail tile counts this browser now, not at the next poll.
    windowChanged(record);
    record.attaching = attach(record).then((context) => {
        record.attaching = undefined;
        if (context === undefined) {
            // Attach window expired with nothing listening; finished here rather than left running forever.
            finish(record);
        }
        return context;
    });
    return name;
};

// Registers a browser this daemon started itself and already holds the context of: the person's own window. No attach
// to poll for and no hook to refresh it; it ends when Chromium disconnects or when it is closed through `shutdown`.
// A finished record under the same name is replaced, so the window keeps one name across every time it is opened.
export const adoptBrowserSession = (input: {
    readonly name: string;
    readonly server: string;
    readonly context: BrowserContext;
    readonly shutdown: () => Promise<void>;
    // Its DevTools port, when it has one: what the tab in front is read off (front-reader.ts).
    readonly port?: number | undefined;
}): void => {
    const now = Date.now();
    const record: BrowserSessionRecord = {
        name: input.name,
        seq: nextSeq(),
        own: true,
        shutdown: input.shutdown,
        owner: undefined,
        server: input.server,
        port: input.port ?? 0,
        passkeyStore: undefined,
        startedAt: now,
        activityAt: now,
        pages: new Map(),
        nextPageId: 1,
        activePageId: undefined,
        lastPageId: undefined,
        front: undefined,
        finishedAt: undefined,
        help: undefined,
        abandonHelp: undefined,
        browser: input.context.browser() ?? undefined,
        context: input.context,
        attaching: undefined,
    };
    sessions.set(input.name, record);
    record.front = readerFor(record, input.context);
    record.browser?.on("disconnected", () => finish(record));
    input.context.on("page", (page) => watchPage(record, page));
    for (const page of input.context.pages()) {
        watchPage(record, page);
    }
    windowChanged(record);
};

// The running window by this name, for its own tools to answer about (downloads/, uploads/, permissions/, devtools/).
export const browserWindowRecord = (name: string): BrowserSessionRecord | undefined => (sessions.get(name)?.finishedAt === undefined ? sessions.get(name) : undefined);

// Whether a session by this name is open now; a finished record still listed for its strip is not.
export const browserSessionRunning = (name: string): boolean => {
    const record = sessions.get(name);
    return record !== undefined && record.finishedAt === undefined && record.context !== undefined;
};

// Opens a tab in a running session and answers its page id, the one the strip and a `bind` know it by. The page is
// registered by the context's own `page` event, so it is looked up rather than minted here.
export const browserSessionNewTab = async (name: string): Promise<{ readonly page: Page; readonly id: string | undefined } | undefined> => {
    const record = sessions.get(name);
    const context = record?.finishedAt === undefined ? record?.context : undefined;
    if (record === undefined || context === undefined) {
        return undefined;
    }
    const page = await context.newPage();
    const idOf = (): string | undefined => [...record.pages.values()].find((entry) => entry.page === page)?.id;
    // The `page` event normally lands before newPage resolves; a few ticks cover a connection that orders them the
    // other way, after which the tab is answered without an id rather than waited on.
    for (let tick = 0; tick < TAB_ID_TICKS && idOf() === undefined; tick += 1) {
        // waiting on one event, a handful of ticks at most
        await sleep(TAB_ID_TICK_MS);
    }
    return { page, id: idOf() };
};

// The tab a freshly started window opened on by itself, so the first address goes there rather than into a second tab
// beside an empty one.
export const browserSessionBlankPage = (name: string): { readonly page: Page; readonly id: string } | undefined => {
    const record = sessions.get(name);
    if (record === undefined || record.finishedAt !== undefined) {
        return undefined;
    }
    const entry = [...record.pages.values()].find(
        (candidate) => !candidate.closed && candidate.deferred === undefined && (candidate.url === "" || candidate.url === "about:blank"),
    );
    return entry === undefined ? undefined : { page: entry.page, id: entry.id };
};

// Live context behind a session, once attach lands. The view route awaits this instead of polling, since the socket can
// open before Chromium's first paint.
export const browserSessionContext = async (name: string): Promise<BrowserContext | undefined> => {
    const record = sessions.get(name);
    if (record === undefined) {
        return undefined;
    }
    return record.context ?? (await record.attaching);
};

// Active page for one account's live browser (accounts-tools.ts's entry point).
// Looked up by account, since a profile lock means at most one running session per account; undefined if it isn't
// browsing.
export const browserAccountPage = (account: string): Page | undefined => {
    const record = [...sessions.values()].find((candidate) => candidate.server === account && candidate.finishedAt === undefined);
    const activeId = record?.activePageId;
    if (record === undefined || activeId === undefined) {
        return undefined;
    }
    const entry = record.pages.get(activeId);
    return entry === undefined || entry.closed ? undefined : entry.page;
};

// Playwright Page a `bind` frame names, for the view route's screencast; undefined once the browser is gone.
// Display key this session's browser runs on: the driving server (`web`, or a logged-in profile owner), the same key
// browser-tools.ts requests a display with.
// The view route uses it to tell a headed browser (real video) from a headless one; see live-view.ts.
export const browserSessionDisplayKey = (name: string): string | undefined => sessions.get(name)?.server;

export const browserSessionPage = (name: string, pageId: string): Page | undefined => {
    const record = sessions.get(name);
    if (record === undefined || record.finishedAt !== undefined) {
        return undefined;
    }
    const entry = record.pages.get(pageId);
    return entry === undefined || entry.closed ? undefined : entry.page;
};

// Answers the dialog the session lists. A dialog the agent answered first throws inside Playwright and is dropped
// here the same way: Chromium's close event has already cleared it, or is about to.
export const answerBrowserDialog = async (name: string, accept: boolean, text?: string): Promise<void> => {
    const record = sessions.get(name);
    const entry = record === undefined ? undefined : [...record.pages.values()].find((candidate) => candidate.dialog !== undefined);
    const dialog = entry?.dialog;
    if (record === undefined || entry === undefined || dialog === undefined) {
        return;
    }
    entry.dialog = undefined;
    windowChanged(record);
    await (accept ? dialog.accept(text) : dialog.dismiss()).catch(() => undefined);
};

export const listBrowserSessions = (): BrowserSession[] => {
    prune(Date.now());
    return [...sessions.values()].map(summarizeWindow);
};

// One window as the list has it, for its view sockets' `state`; undefined once it is no longer listed.
export const browserSessionState = (name: string): BrowserSession | undefined => {
    const record = sessions.get(name);
    return record === undefined ? undefined : summarizeWindow(record);
};

// The tab the window has in front, which its picture follows (live-view.ts); undefined for a closed window.
export const browserSessionFront = (name: string): Page | undefined => {
    const record = sessions.get(name);
    const entry = record?.activePageId === undefined ? undefined : record.pages.get(record.activePageId);
    return record?.finishedAt !== undefined || entry === undefined || entry.closed ? undefined : entry.page;
};

// A person picked a tab: brought in front for real, since the window shows one tab to every viewer, and told at once
// rather than when Chromium is next asked. Undefined when the tab or the window is gone.
export const pickBrowserPage = async (name: string, pageId: string): Promise<Page | undefined> => {
    const record = sessions.get(name);
    const entry = record?.finishedAt === undefined ? record?.pages.get(pageId) : undefined;
    if (record === undefined || entry === undefined || entry.closed) {
        return undefined;
    }
    // allow(silent-catch): a tab closing as it is picked is answered by its own close event.
    await entry.page.bringToFront().catch(() => undefined);
    record.picks = (record.picks ?? 0) + 1;
    bringForward(record, entry.id);
    windowChanged(record, true);
    return entry.page;
};

export const browserSessionMetrics = (): Readonly<Record<string, number>> => {
    prune(Date.now());
    let running = 0;
    let finished = 0;
    let retainedPages = 0;
    let openPages = 0;
    let attaching = 0;
    for (const session of sessions.values()) {
        running += session.finishedAt === undefined ? 1 : 0;
        finished += session.finishedAt === undefined ? 0 : 1;
        retainedPages += session.pages.size;
        for (const page of session.pages.values()) {
            openPages += page.closed ? 0 : 1;
        }
        attaching += session.attaching === undefined ? 0 : 1;
    }
    return { sessions: sessions.size, running, finished, retainedPages, openPages, attaching };
};

// Kill route's answer for a `browser-*` name: ends the agent's browsing for that turn, the way killing an `agent-*`
// session ends its shell.
// The tool call in flight fails and the agent is told so.
export const closeBrowserSession = async (name: string): Promise<void> => {
    const record = sessions.get(name);
    if (record === undefined) {
        return;
    }
    const { browser, shutdown } = record;
    finish(record);
    await (shutdown === undefined ? browser?.close() : shutdown())?.catch(() => undefined);
};

// Closes every running record a conversation owns (platform/reaper.ts): a backstop for a disconnect that never fired,
// and the hard stop on archive/discard.
export const closeBrowserSessionsFor = async (owner: string, idleOnly = false): Promise<void> => {
    const mine = [...sessions.values()].filter((record) => record.owner === owner && record.finishedAt === undefined && (!idleOnly || unused(record)));
    await Promise.all(mine.map((record) => closeBrowserSession(record.name)));
};

// Owners with a running record; lets the reaper stop-clock a browser whose conversation left no terminal behind.
export const runningBrowserOwners = (): string[] => [
    ...new Set([...sessions.values()].flatMap((record) => (record.finishedAt === undefined && record.owner !== undefined ? [record.owner] : []))),
];

// Running sessions nobody has driven for `idleMs`, by name — judged on the session's OWN clock rather than its owner's.
//
// The reaper's other browser pass closes by owner, which only fires once the conversation has no run in flight: a
// conversation that keeps working never releases a Chromium it has finished with. Measured: a browser left open 21
// minutes into a session that had moved on to other things, 25 processes for 2 browsers. `activityAt` is stamped by
// the PostToolUse hook on every browser call, so "idle" here means no browser tool has run, not that the turn is quiet.
//
// A session parked on a help request is never idle: the agent is blocked precisely BECAUSE nobody has driven it, and
// closing it would answer the owner's pending question by destroying what it was about. Nor is the person's own
// window: a browser left open on a desktop is still open when its owner comes back to it, and theirs is closed by them.
export const idleBrowserSessionNames = (now: number, idleMs: number): string[] =>
    [...sessions.values()]
        .filter((record) => !record.own && record.finishedAt === undefined && unused(record) && record.activityAt <= now - idleMs)
        .map((record) => record.name);
