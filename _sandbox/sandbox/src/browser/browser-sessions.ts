import { setTimeout as sleep } from "node:timers/promises";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract";
import { browserSessionName } from "@intentic/sandbox-contract/session-names";
import type { Browser, BrowserContext, Page } from "playwright";
import { resolveRequest } from "../agent/agent-requests.js";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { armPasskeys } from "./passkeys.js";

/* THE AGENT'S BROWSER, AS A THING THE DAEMON CAN NAME.
 *
 * A turn that browses used to be invisible. @playwright/mcp is a stdio grandchild of the SDK and it launches
 * its own Chromium, so nothing in the daemon held a handle to the browser the agent was driving: it could not
 * be listed, counted, or looked at, and four minutes of clicking through the user's own app left them a column
 * of gray tool cards. Meanwhile the machinery for watching a browser already existed one directory over — the
 * guided login screencasts a live Chromium to the web app and takes the owner's clicks back (screencast.ts).
 * The two halves had simply never been connected.
 *
 * This module is the connection, and it deliberately does NOT take the browser's lifecycle away from the MCP.
 * The MCP still launches Chromium lazily (a turn that never browses starts nothing) and still tears it down
 * when the turn ends. All we add is `--remote-debugging-port` on the launch (browser-tools.ts writes it into
 * the MCP's config file) and an observer that attaches over CDP the first time the agent calls a browser tool.
 * That inversion is the whole reason this is cheap: no daemon-owned process to leak, no lifecycle to babysit,
 * no behaviour change for a turn nobody watches.
 *
 * A session is named per SDK session (`browser-<id8>`, the same derivation agent-terminals.ts uses) and is
 * `running` while its Chromium is connected. What it is NOT is a terminal: it lists from its own route
 * (/system/browsers) rather than beside the tmux sessions, because a browser holds SEVERAL pages at once and a
 * surface that can only show one stream has no way to ask which. So this module tracks every page the context
 * opens, not merely the newest, and the web app renders them as the tab strip of a browser in its own rail
 * area. `browserSessionPage` is the other half of that: the view route's `bind` frame names a page id, and
 * this is what turns it back into something the screencast can point at. */

// How long to keep asking Chromium's DevTools endpoint to answer. The first browser tool call is what triggers
// the attach, and Chromium is coming up underneath it — a cold launch plus the first navigation is seconds, not
// tens of them, but a slow container image start deserves room.
const ATTACH_TIMEOUT_MS = 45_000;
const ATTACH_POLL_MS = 250;

// A finished session stays listable this long so the Recent-browsers row can still be read (and its last URL
// seen) after the turn that ran it ended — the same window tmux sessions get (terminal-session.ts).
const RETAIN_FINISHED_MS = 2 * 3_600_000;

/* One page the browser has open — a tab in the view's tab strip, and the thing a `bind` frame names.
 *
 * The `page` handle is held so that binding is a lookup rather than a search: the view route says "stream id
 * p3" and there is a Playwright Page to point the screencast at, with no re-derivation from a url that may have
 * changed since. The id is minted per session (`p1`, `p2`, …) — opaque to the client, stable for the page's
 * life, and never reused, so a tab the user has selected cannot silently become a different page. */
interface PageRecord {
    readonly id: string;
    readonly page: Page;
    url: string;
    title: string | undefined;
    // Marked rather than deleted, because Chromium going away closes every page at once and the ORDER of that
    // against the browser's own `disconnected` is not guaranteed. Deleting here would therefore empty a
    // finished session's strip in a race we don't control — and where the agent went is the whole value of a
    // session that has ended. So a closed page merely stops being listed while the session is still running.
    closed: boolean;
}

// What the daemon knows about one agent browser. `context` arrives only once the CDP attach lands; everything
// before that is what the hook could say without looking.
interface BrowserSessionRecord {
    readonly name: string;
    // The conversation whose turn drives it — the reaper's key (platform/reaper.ts): a stopped conversation's
    // records are closed by owner, without deriving anything from the session name. Undefined for a turn with
    // no conversation behind it (the bench), which only ever ages out on the retention prune.
    readonly owner: string | undefined;
    // Which MCP server drives it: `web` (the credential-free browser) or a logged-in capability's id.
    readonly server: string;
    readonly port: number;
    // The platform's passkey store for a logged-in capability's browser — the observer arms every page with the
    // sandbox's software security key from it (passkeys.ts). Undefined for `web`, which holds no identity.
    readonly passkeyStore: string | undefined;
    readonly startedAt: number;
    activityAt: number;
    // Every page currently open, in the order they were opened — which is the order a browser shows its tabs.
    readonly pages: Map<string, PageRecord>;
    nextPageId: number;
    // The page the agent last drove AND that is still open — what the tab strip highlights. Falls back as tabs
    // close, and is undefined once none are left.
    activePageId: string | undefined;
    // The page the agent last drove, full stop. Never walked back, because a finished session's whole value is
    // where it ENDED: without this every finished pill degrades to the server name ("web") at exactly the moment
    // its label is the only thing left to tell two records apart. It has to be a SEPARATE field rather than a
    // softer rule on the one above — Chromium going away closes every page at once in an order nothing here
    // controls, so the field a close handler walks cannot also be the field that remembers.
    lastPageId: string | undefined;
    // Set when the browser went away (turn ended, agent called browser_close, Chromium crashed).
    finishedAt: number | undefined;
    // The open help request parked on this browser (accounts-tools.ts): the agent hit something only a person
    // can clear and is waiting. Carried here because the Browsers view is where the person can actually act —
    // the banner renders from the summary, and its buttons settle the request by its id. Cleared the moment the
    // waiter settles, and by `finish`: a browser that is gone has nothing left to take control of, so a banner
    // over its record could only mislead (the parked tool call is settled by its own abort, not from here).
    help: { readonly requestId: string; readonly message: string; readonly requestedAt: number } | undefined;
    browser: Browser | undefined;
    context: BrowserContext | undefined;
    // The in-flight attach, so a second tool call doesn't start a second one and the view route can await it.
    attaching: Promise<BrowserContext | undefined> | undefined;
}

const sessions = new Map<string, BrowserSessionRecord>();

// The tmux sessions age out on their own clock; these have no server to sweep them, so every list prunes.
const prune = (now: number): void => {
    for (const [name, record] of sessions) {
        if (record.finishedAt !== undefined && record.finishedAt <= now - RETAIN_FINISHED_MS) {
            sessions.delete(name);
        }
    }
};

// `mcp__web__browser_navigate` → `web`. The server segment is the tool prefix @playwright/mcp was mounted
// under (browser-tools.ts), which is what says WHICH browser — the credential-free one or a logged-in profile.
export const browserServerOfTool = (tool: string): string | undefined => {
    const match = /^mcp__(.+)__browser_/.exec(tool);
    return match?.[1];
};

/* A page's own account of itself, for its tab and the session's label. Title first (that is what a tab says),
 * and the URL beside it — a page mid-navigation has one and not the other, so the title stays optional.
 *
 * Noting a page also makes it the ACTIVE one, which is this module's whole definition of "what the agent is
 * looking at": the page it most recently opened, navigated, or loaded. There is no CDP signal for which tab is
 * foreground that survives a headless browser, and this stands in for it exactly where it matters — the agent
 * drives one page at a time, and the one it just touched is the one worth watching. */
const notePage = async (record: BrowserSessionRecord, entry: PageRecord): Promise<void> => {
    record.activityAt = Date.now();
    record.activePageId = entry.id;
    record.lastPageId = entry.id;
    entry.url = entry.page.url();
    // A page that navigated out from under us throws here; the next event carries the new title. An EMPTY title
    // is the same fact as no title — about:blank has one — and a tab labelled with nothing is worse than a tab
    // labelled with its host, so it falls through the same ladder.
    const title = await entry.page.title().catch(() => undefined);
    entry.title = title === undefined || title === "" ? undefined : title;
    // The tile and the tab strip both draw the ACTIVE page's title — so the agent navigating IS the roster
    // changing, and it is the change most worth watching happen. Rate-limited on the bus, not here.
    publishRuntimeChange("browsers");
};

const watchPage = (record: BrowserSessionRecord, page: Page): void => {
    const entry: PageRecord = { id: `p${record.nextPageId}`, page, url: page.url(), title: undefined, closed: false };
    record.nextPageId += 1;
    record.pages.set(entry.id, entry);
    // A logged-in browser's page gets the platform's passkey plugged in the moment the observer sees it —
    // best-effort, because a page that closed under the arm is a page nobody will run a ceremony on.
    if (record.passkeyStore !== undefined && record.context !== undefined) {
        void armPasskeys(record.context, page, record.passkeyStore).catch(() => undefined);
    }
    void notePage(record, entry);
    page.on("framenavigated", (frame) => {
        if (frame.parentFrame() === null) {
            void notePage(record, entry);
        }
    });
    // A title set by script after load (SPAs do this on every route change) — the DOM event is the only signal.
    page.on("domcontentloaded", () => void notePage(record, entry));
    // A closed tab leaves the strip. The active slot falls back to the last page still open — the same
    // follow-the-newest rule the screencast uses when the page it was bound to goes away. `lastPageId` is
    // deliberately NOT touched here; that is the half of this that has to survive the browser going away.
    page.on("close", () => {
        entry.closed = true;
        if (record.activePageId === entry.id) {
            record.activePageId = [...record.pages.values()].findLast((other) => !other.closed)?.id;
        }
    });
};

// The page records are deliberately left alone: a finished session's value is the record of where the agent
// went (summarize switches to listing all of them). The Page handles they hold are dead along with their
// Chromium, which is why browserSessionPage refuses a finished session outright.
const finish = (record: BrowserSessionRecord): void => {
    record.finishedAt ??= Date.now();
    // A browser that dies UNDER a parked help request settles that request itself, as "not helped": the parked
    // tool call is waiting on the user, not on Chromium, so nothing else would ever release it — the turn would
    // sit parked on a banner this same finish just took down. Idempotent against the turn-abort settle racing in.
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

/* The help-request half the accounts tools drive (accounts-tools.ts holds the waiter; this module holds the
 * STATE, because the state is what the /system/browsers list and the view's banner render from).
 *
 * Addressed BY ACCOUNT rather than by session name: the tool call that parks knows which account's sign-in it
 * is stuck on, and a persistent profile can only be open once, so at most one RUNNING session drives a given
 * account at a time — the lookup cannot land on the wrong browser. Returns the session's name (what the chat
 * card deep-links to), or undefined when that account has no live browser to take control of, which the tool
 * reports as an error instead of parking the turn on a banner nobody can act on. */
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

// The waiter settled (answered, dismissed, or the turn aborted under it) — the banner comes down however it
// ended. By requestId rather than name so a settle can never clear a NEWER request raised on the same session.
export const clearBrowserHelp = (requestId: string): void => {
    for (const record of sessions.values()) {
        if (record.help?.requestId === requestId) {
            record.help = undefined;
            publishRuntimeChange("browsers");
        }
    }
};

// Wait for Chromium's DevTools HTTP endpoint, then attach. Deliberately tolerant: an attach that never lands
// (Chromium refused the port, the turn ended first) leaves a session that still LISTS — the agent really is
// browsing — it just can't be watched. Silence beats a session that vanishes because the observer failed.
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
            // The MCP's Chromium going away IS the session ending — there is no other signal, since the process
            // belongs to the SDK's child tree and not to us.
            browser.on("disconnected", () => finish(record));
            context.on("page", (page) => watchPage(record, page));
            for (const page of context.pages()) {
                watchPage(record, page);
            }
            return context;
        } catch {
            // Not listening yet — Chromium is still coming up under the tool call that triggered this.
            await sleep(ATTACH_POLL_MS);
        }
    }
    return undefined;
};

// Register (or refresh) the session behind a browser tool call, and start the attach on first sight. Called
// from the PreToolUse hook — the moment the agent uses a browser tool is the moment a browser session becomes
// a real thing, and the moment it should appear on the rail.
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
    // Same session, same browser: just a later tool call. A DIFFERENT port means the next turn of this
    // conversation launched a fresh Chromium (the MCP is per-turn), so the record is replaced rather than
    // merged — its predecessor's browser is already gone.
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
    // A browser the agent just minted — the rail tile should count it now, not at the end of somebody's poll.
    publishRuntimeChange("browsers");
    record.attaching = attach(record).then((context) => {
        record.attaching = undefined;
        if (context === undefined) {
            // The whole attach window went by with nothing listening on the port. There is no second signal to
            // wait for — a session we never connected to has no `disconnected` event coming — so it is finished
            // here rather than left `running` forever, which would pin a browser to the rail that nobody can
            // open. A later tool call on the same port re-registers it and tries again.
            finish(record);
        }
        return context;
    });
    return name;
};

// The live context behind a session, once the attach lands. The view route awaits this rather than polling:
// the socket opens the instant the user clicks Watch, which can be ahead of Chromium's first paint.
export const browserSessionContext = async (name: string): Promise<BrowserContext | undefined> => {
    const record = sessions.get(name);
    if (record === undefined) {
        return undefined;
    }
    return record.context ?? (await record.attaching);
};

/* The page the agent is ON in one account's live browser — the accounts tools' way in (accounts-tools.ts).
 * Looked up by ACCOUNT for the reason raiseBrowserHelp is: the profile lock means at most one running session
 * drives an account, so the account names the browser unambiguously where a session name would make the model
 * relay an identifier it has no other use for. Undefined when that account isn't browsing right now (no
 * session, finished, or the attach hasn't landed) — the callers' "open the login page first" error. */
export const browserAccountPage = (account: string): Page | undefined => {
    const record = [...sessions.values()].find((candidate) => candidate.server === account && candidate.finishedAt === undefined);
    const activeId = record?.activePageId;
    if (record === undefined || activeId === undefined) {
        return undefined;
    }
    const entry = record.pages.get(activeId);
    return entry === undefined || entry.closed ? undefined : entry.page;
};

// The Playwright Page one `bind` frame names, for the view route to point its screencast at. Undefined once
// the browser is gone: the handles a finished session still lists are dead, and binding one would throw deep
// inside CDP rather than telling the client what actually happened.
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

/* A live session lists the tabs it has OPEN; a finished one lists every tab it ever had.
 *
 * That asymmetry is the point rather than an accident of bookkeeping. While the browser runs, a closed tab is
 * noise — it cannot be watched and the agent has moved on. Once it is gone, nothing here can be watched at all
 * and the only question left is where it went, which the full list answers and a live-only list answers with a
 * blank strip. */
// A page mid-navigation has no title yet, and `title` is optional rather than nullable — so it is omitted
// rather than set to undefined (the repo's exactOptionalPropertyTypes rule).
const summarizePage = (entry: PageRecord, activeId: string | undefined): BrowserPage => {
    const page: BrowserPage = { id: entry.id, url: entry.url, active: entry.id === activeId };
    return entry.title === undefined ? page : { ...page, title: entry.title };
};

const summarize = (record: BrowserSessionRecord): BrowserSession => {
    const running = record.finishedAt === undefined;
    // A running session points at the tab the agent is ON; a finished one at the tab it ENDED on — the same
    // asymmetry as the page list above, and for the same reason.
    const activeId = running ? record.activePageId : record.lastPageId;
    const active = activeId === undefined ? undefined : record.pages.get(activeId);
    // A logged-in browser is SOMEONE'S — the server key is the profile owner (an identity, or a standalone
    // account), and leading with it is what tells two identities' browsers apart when both are open on the same
    // site. The credential-free `web` browser is nobody's and keeps the page-first label.
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

// Close one session's browser — the kill route's answer for a `browser-*` name. Ends the agent's browsing for
// that turn, exactly as killing an `agent-*` tmux session ends its shell; the tool call in flight fails and the
// agent is told so, which is the honest outcome of the owner pulling the plug.
export const closeBrowserSession = async (name: string): Promise<void> => {
    const record = sessions.get(name);
    if (record === undefined) {
        return;
    }
    const { browser } = record;
    finish(record);
    await browser?.close().catch(() => undefined);
};

// Close every running record a conversation owns — the reaper's door (platform/reaper.ts). Chromium normally
// dies with the turn's own process tree; this is the backstop for a record whose disconnect never fired, and
// the hard stop when the conversation is archived or discarded.
export const closeBrowserSessionsFor = async (owner: string): Promise<void> => {
    const mine = [...sessions.values()].filter((record) => record.owner === owner && record.finishedAt === undefined);
    await Promise.all(mine.map((record) => closeBrowserSession(record.name)));
};

// Every owner with a RUNNING record — what the reaper walks so a browser whose conversation stopped without
// leaving a terminal behind still lands on the stop clock (platform/reaper.ts sweepBrowsers).
export const runningBrowserOwners = (): string[] => [
    ...new Set([...sessions.values()].flatMap((record) => (record.finishedAt === undefined && record.owner !== undefined ? [record.owner] : []))),
];

/* The hooks that make the above happen. PreToolUse fires with the browser tool's name and the SDK session id —
 * everything needed to name the session and start watching — while the tool itself is still launching Chromium,
 * so the session appears on the rail at the START of the first navigation rather than after it. PostToolUse
 * stamps the clock, which is what keeps a long browsing turn reading as active between attaches.
 *
 * `ports` is the per-turn map browser-tools.ts allocated: server name → the debugging port its Chromium was
 * told to listen on. A tool whose server isn't in it (there is no such call today) simply isn't watched.
 * `passkeys` is its sibling from the same allocation: the logged-in servers' passkey store paths, which is what
 * lets the observer arm the pages it watches. */
export const browserSessionHooks = (
    ports: Record<string, number>,
    passkeys: Record<string, string> = {},
    // The conversation this turn belongs to — rides every record the hook opens, so the reaper can close a
    // stopped conversation's browsers by owner (platform/reaper.ts).
    owner?: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const matcher = "mcp__.+__browser_.+";
    const touch = async (tool: string, sessionId: string): Promise<void> => {
        const server = browserServerOfTool(tool);
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
                            await touch(input.tool_name, input.session_id);
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
                            await touch(input.tool_name, input.session_id);
                        }
                        return {};
                    },
                ],
            },
        ],
    };
};
