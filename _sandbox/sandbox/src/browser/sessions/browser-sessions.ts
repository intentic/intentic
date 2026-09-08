import { setTimeout as sleep } from "node:timers/promises";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract";
import { browserSessionName } from "@intentic/sandbox-contract/session-names";
import type { Browser, BrowserContext, Page } from "playwright";
import { resolveRequest } from "../../agent/tools/agent-requests.js";
import { publishRuntimeChange } from "../../system/runtime-watch.js";
import { ROUTED_BROWSER_SERVER } from "../tools/browser-tools.js";
import { armPasskeys } from "../tools/passkeys.js";

// Makes the agent's browser (launched and owned by @playwright/mcp) visible to the daemon: it attaches over CDP the
// first time a browser tool is called, without taking over Chromium's lifecycle.
// Sessions are named `browser-<id8>` and track every open page, not just the newest, since a browser can hold several
// tabs at once.
// browserSessionPage turns a page id from a `bind` frame back into a Page the screencast can point at.

// Chromium's cold-launch attach window; generous for a slow container start.
const ATTACH_TIMEOUT_MS = 45_000;
const ATTACH_POLL_MS = 250;

// How long a finished session stays listable, matching terminal-session.ts's retention window.
const RETAIN_FINISHED_MS = 2 * 3_600_000;

// One open tab: `page` is held so a bind looks it up rather than re-deriving from a possibly-stale url.
// id is minted per session (p1, p2, …), opaque, stable for the page's life, and never reused.
interface PageRecord {
    readonly id: string;
    readonly page: Page;
    url: string;
    title: string | undefined;
    // Marked, not deleted: close/disconnect order isn't guaranteed; deletion could empty a finished session's strip.
    closed: boolean;
}

// What the daemon knows about one agent browser; `context` is set only once the CDP attach lands.
interface BrowserSessionRecord {
    readonly name: string;
    // Owning conversation, the reaper's key; undefined for a turn with no conversation (the bench).
    readonly owner: string | undefined;
    // MCP server driving it: `web`, or a logged-in capability's id.
    readonly server: string;
    readonly port: number;
    // Passkey store for a logged-in capability; undefined for `web`, which holds no identity.
    readonly passkeyStore: string | undefined;
    readonly startedAt: number;
    activityAt: number;
    // Open pages, in open order, the order a browser's tab strip shows them.
    readonly pages: Map<string, PageRecord>;
    nextPageId: number;
    // Last-driven page still open, the tab strip highlight; falls back as tabs close, undefined once none remain.
    activePageId: string | undefined;
    // Last page driven, never walked back (unlike activePageId); a finished session's label needs where it ended.
    lastPageId: string | undefined;
    // Set when the browser went away: turn ended, browser_close, or Chromium crashed.
    finishedAt: number | undefined;
    // Parked help request the agent is blocked on; cleared when the waiter settles or the session finishes.
    help: { readonly requestId: string; readonly message: string; readonly requestedAt: number } | undefined;
    browser: Browser | undefined;
    context: BrowserContext | undefined;
    // In-flight attach; a second tool call doesn't start another one, and the view route can await it.
    attaching: Promise<BrowserContext | undefined> | undefined;
}

const sessions = new Map<string, BrowserSessionRecord>();

// No background sweep; every list call prunes expired sessions first.
const prune = (now: number): void => {
    for (const [name, record] of sessions) {
        if (record.finishedAt !== undefined && record.finishedAt <= now - RETAIN_FINISHED_MS) {
            sessions.delete(name);
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

// Owner of the browser one tool call drives: for the routed server, `account` resolves through the turn's account map;
// every other server is its own answer.
// Undefined when a routed call names an account it isn't allowed to act as.
const ownerOfBrowserCall = (tool: string, toolInput: unknown, accounts: Record<string, string>): string | undefined => {
    const server = browserServerOfTool(tool);
    if (server !== ROUTED_BROWSER_SERVER) {
        return server;
    }
    const account = (toolInput as { account?: unknown } | undefined)?.account;
    return typeof account === "string" ? accounts[account] : undefined;
};

// Records a page's current url/title and marks it active, this module's stand-in for foreground, since there's no CDP
// signal for it in a headless browser.
// Title is optional: a page mid-navigation may have a url but not yet a title.
const notePage = async (record: BrowserSessionRecord, entry: PageRecord): Promise<void> => {
    record.activityAt = Date.now();
    record.activePageId = entry.id;
    record.lastPageId = entry.id;
    entry.url = entry.page.url();
    // Throws if the page navigated away mid-read; the next event retries. An empty title counts as no title.
    const title = await entry.page.title().catch(() => undefined);
    entry.title = title === undefined || title === "" ? undefined : title;
    // Navigating the active page is what changes the roster; rate-limited on the bus, not here.
    publishRuntimeChange("browsers");
};

const watchPage = (record: BrowserSessionRecord, page: Page): void => {
    const entry: PageRecord = { id: `p${record.nextPageId}`, page, url: page.url(), title: undefined, closed: false };
    record.nextPageId += 1;
    record.pages.set(entry.id, entry);
    // Best-effort: arm failures are swallowed silently here (no logger), unlike the logged guided-login path.
    if (record.passkeyStore !== undefined && record.context !== undefined) {
        void armPasskeys(record.context, page, record.passkeyStore).catch(() => undefined);
    }
    void notePage(record, entry);
    page.on("framenavigated", (frame) => {
        if (frame.parentFrame() === null) {
            void notePage(record, entry);
        }
    });
    // SPA titles set post-load; domcontentloaded is the only signal for that.
    page.on("domcontentloaded", () => void notePage(record, entry));
    // Closed tab leaves the strip; active falls back to the newest still-open page. lastPageId is untouched here.
    page.on("close", () => {
        entry.closed = true;
        if (record.activePageId === entry.id) {
            record.activePageId = [...record.pages.values()].findLast((other) => !other.closed)?.id;
        }
    });
};

// Page records stay: a finished session's value is where the agent went. Their Page handles are dead, so
// browserSessionPage refuses any finished session.
const finish = (record: BrowserSessionRecord): void => {
    record.finishedAt ??= Date.now();
    // Settles any parked help request as not-helped; idempotent against a racing turn-abort settle.
    if (record.help !== undefined) {
        resolveRequest({
            kind: "browser_help",
            requestId: record.help.requestId,
            helped: false,
            note: "the browser closed before anyone could help",
        });
        record.help = undefined;
    }
    record.browser = undefined;
    record.context = undefined;
    record.attaching = undefined;
    publishRuntimeChange("browsers");
};

// State side of the help-request flow (accounts-tools.ts holds the waiter); the view's banner renders from this.
// Looked up by account, since a profile can only be open in one running session; undefined if that account isn't
// browsing.
export const raiseBrowserHelp = (
    account: string,
    help: { readonly requestId: string; readonly message: string; readonly requestedAt: number },
): string | undefined => {
    const record = [...sessions.values()].find((candidate) => candidate.server === account && candidate.finishedAt === undefined);
    if (record === undefined) {
        return undefined;
    }
    record.help = help;
    publishRuntimeChange("browsers");
    return record.name;
};

// Clears by requestId, not session name, so this can't clear a newer request raised on the same session.
export const clearBrowserHelp = (requestId: string): void => {
    for (const record of sessions.values()) {
        if (record.help?.requestId === requestId) {
            record.help = undefined;
            publishRuntimeChange("browsers");
        }
    }
};

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
    if (existing !== undefined && existing.port === input.port && existing.finishedAt === undefined) {
        existing.activityAt = Date.now();
        return name;
    }
    const record: BrowserSessionRecord = {
        name,
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
        finishedAt: undefined,
        help: undefined,
        browser: undefined,
        context: undefined,
        attaching: undefined,
    };
    sessions.set(name, record);
    // Published immediately so the rail tile counts this browser now, not at the next poll.
    publishRuntimeChange("browsers");
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

const hostOf = (url: string | undefined): string | undefined => {
    if (url === undefined || url === "" || url === "about:blank") {
        return undefined;
    }
    try {
        return new URL(url).host;
    } catch {
        return undefined;
    }
};

// Live sessions list only open tabs; finished ones list every tab they ever had, since a closed browser only answers
// where it went.
// title is omitted rather than set to undefined, per exactOptionalPropertyTypes.
const summarizePage = (entry: PageRecord, activeId: string | undefined): BrowserPage => {
    const page: BrowserPage = { id: entry.id, url: entry.url, active: entry.id === activeId };
    return entry.title === undefined ? page : { ...page, title: entry.title };
};

const summarize = (record: BrowserSessionRecord): BrowserSession => {
    const running = record.finishedAt === undefined;
    // Running session's active tab is the one being driven; finished one's is the one it ended on.
    const activeId = running ? record.activePageId : record.lastPageId;
    const active = activeId === undefined ? undefined : record.pages.get(activeId);
    // Logged-in label leads with owner so same-site identities stay distinct; web has none, so it's page-first.
    const page = active?.title ?? hostOf(active?.url);
    const session: BrowserSession = {
        name: record.name,
        label: record.server === "web" ? (page ?? record.server) : page === undefined ? record.server : `${record.server} · ${page}`,
        server: record.server,
        running,
        activityAt: record.activityAt,
        pages: [...record.pages.values()].filter((entry) => !running || !entry.closed).map((entry) => summarizePage(entry, activeId)),
    };
    const withHelp = record.help === undefined ? session : { ...session, help: record.help };
    return running ? withHelp : { ...withHelp, finishedAt: record.finishedAt };
};

export const listBrowserSessions = (): BrowserSession[] => {
    prune(Date.now());
    return [...sessions.values()].map(summarize);
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
    const { browser } = record;
    finish(record);
    await browser?.close().catch(() => undefined);
};

// Closes every running record a conversation owns (platform/reaper.ts): a backstop for a disconnect that never fired,
// and the hard stop on archive/discard.
export const closeBrowserSessionsFor = async (owner: string): Promise<void> => {
    const mine = [...sessions.values()].filter((record) => record.owner === owner && record.finishedAt === undefined);
    await Promise.all(mine.map((record) => closeBrowserSession(record.name)));
};

// Owners with a running record; lets the reaper stop-clock a browser whose conversation left no terminal behind.
export const runningBrowserOwners = (): string[] => [
    ...new Set([...sessions.values()].flatMap((record) => (record.finishedAt === undefined && record.owner !== undefined ? [record.owner] : []))),
];

// Hooks that register or refresh a browser session: PreToolUse fires before Chromium launches, so the session appears
// at the start of navigation; PostToolUse stamps activity so a long turn keeps reading as active.
// ports/passkeys are the per-turn owner-to-port and owner-to-passkey-store maps from browser-tools.ts; accounts is the
// router's account-to-owner map, needed since a routed tool name alone doesn't say whose browser.
export const browserSessionHooks = (
    ports: Record<string, number>,
    passkeys: Record<string, string> = {},
    accounts: Record<string, string> = {},
    // Conversation this turn belongs to; carried on every record so the reaper can close by owner.
    owner?: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const matcher = "mcp__.+__browser_.+";
    const touch = async (tool: string, toolInput: unknown, sessionId: string): Promise<void> => {
        const server = ownerOfBrowserCall(tool, toolInput, accounts);
        const port = server === undefined ? undefined : ports[server];
        if (server === undefined || port === undefined) {
            return;
        }
        openBrowserSession({ sessionId, server, port, passkeyStore: passkeys[server], owner });
    };
    return {
        PreToolUse: [
            {
                matcher,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name === "PreToolUse") {
                            await touch(input.tool_name, input.tool_input, input.session_id);
                        }
                        return {};
                    },
                ],
            },
        ],
        PostToolUse: [
            {
                matcher,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name === "PostToolUse") {
                            await touch(input.tool_name, input.tool_input, input.session_id);
                        }
                        return {};
                    },
                ],
            },
        ],
    };
};
