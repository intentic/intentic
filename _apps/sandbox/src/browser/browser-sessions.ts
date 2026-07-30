import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { Browser, BrowserContext, Page } from "playwright";

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
 * A session is therefore shaped exactly like an `agent-*` tmux session, and for the same reason — it is a
 * RECORD OF WORK, not a place the user keeps. It is named per SDK session (`browser-<id8>`, the same
 * derivation agent-terminals.ts uses), it is `running` while its Chromium is connected, and the web app hides
 * it from the tab strip until someone explicitly asks to watch. See system.routes.ts, where it lists beside
 * the tmux sessions, because from the panel's side there is one question ("what is happening right now?") and
 * it should have one answer. */

export const BROWSER_SESSION_PREFIX = "browser-";

// How long to keep asking Chromium's DevTools endpoint to answer. The first browser tool call is what triggers
// the attach, and Chromium is coming up underneath it — a cold launch plus the first navigation is seconds, not
// tens of them, but a slow container image start deserves room.
const ATTACH_TIMEOUT_MS = 45_000;
const ATTACH_POLL_MS = 250;

// A finished session stays listable this long so the Recent-browsers row can still be read (and its last URL
// seen) after the turn that ran it ended — the same window tmux sessions get (terminal-session.ts).
const RETAIN_FINISHED_MS = 2 * 3_600_000;

// What the daemon knows about one agent browser. `context` arrives only once the CDP attach lands; everything
// before that is what the hook could say without looking.
interface BrowserSessionRecord {
    readonly name: string;
    // Which MCP server drives it: `web` (the credential-free browser) or a logged-in capability's id.
    readonly server: string;
    readonly port: number;
    readonly startedAt: number;
    activityAt: number;
    url: string | undefined;
    title: string | undefined;
    // Set when the browser went away (turn ended, agent called browser_close, Chromium crashed).
    finishedAt: number | undefined;
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

// The browser session for one SDK session — `browser-<8 chars of the session UUID>`, the same 8 chars
// agentSessionName takes, so a conversation's shell and its browser read as the pair they are. undefined when
// the id sanitizes to empty (never a valid session name).
export const browserSessionName = (sessionId: string): string | undefined => {
    const id = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
    return id === "" ? undefined : `${BROWSER_SESSION_PREFIX}${id}`;
};

// `mcp__web__browser_navigate` → `web`. The server segment is the tool prefix @playwright/mcp was mounted
// under (browser-tools.ts), which is what says WHICH browser — the credential-free one or a logged-in profile.
export const browserServerOfTool = (tool: string): string | undefined => {
    const match = /^mcp__(.+)__browser_/.exec(tool);
    return match?.[1];
};

// A page's own account of itself, for the pill and its tooltip. Title first (that is what a tab says), and the
// URL as the second line — a page mid-navigation has one and not the other, so both are optional.
const notePage = async (record: BrowserSessionRecord, page: Page): Promise<void> => {
    record.activityAt = Date.now();
    record.url = page.url();
    // A page that navigated out from under us throws here; the next event carries the new title.
    record.title = await page.title().catch(() => undefined);
};

const watchPage = (record: BrowserSessionRecord, page: Page): void => {
    void notePage(record, page);
    page.on("framenavigated", (frame) => {
        if (frame.parentFrame() === null) {
            void notePage(record, page);
        }
    });
    // A title set by script after load (SPAs do this on every route change) — the DOM event is the only signal.
    page.on("domcontentloaded", () => void notePage(record, page));
};

const finish = (record: BrowserSessionRecord): void => {
    record.finishedAt ??= Date.now();
    record.browser = undefined;
    record.context = undefined;
    record.attaching = undefined;
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
            await new Promise((resolve) => setTimeout(resolve, ATTACH_POLL_MS));
        }
    }
    return undefined;
};

// Register (or refresh) the session behind a browser tool call, and start the attach on first sight. Called
// from the PreToolUse hook — the moment the agent uses a browser tool is the moment a browser session becomes
// a real thing, and the moment it should appear on the rail.
export const openBrowserSession = (input: { readonly sessionId: string; readonly server: string; readonly port: number }): string | undefined => {
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
        server: input.server,
        port: input.port,
        startedAt: Date.now(),
        activityAt: Date.now(),
        url: undefined,
        title: undefined,
        finishedAt: undefined,
        browser: undefined,
        context: undefined,
        attaching: undefined,
    };
    sessions.set(name, record);
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

// One listable session. Mirrors the fields TerminalSessionSchema carries for a tmux session, because that is
// the list this joins (system.routes.ts).
export interface BrowserSessionSummary {
    readonly name: string;
    // The pill's text: the page's own title, else its host, else which browser this is.
    readonly label: string;
    readonly running: boolean;
    readonly activityAt: number;
    readonly url?: string;
}

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

const summarize = (record: BrowserSessionRecord): BrowserSessionSummary => ({
    name: record.name,
    label: record.title ?? hostOf(record.url) ?? record.server,
    running: record.finishedAt === undefined,
    activityAt: record.activityAt,
    ...(record.url !== undefined ? { url: record.url } : {}),
});

export const listBrowserSessions = (): BrowserSessionSummary[] => {
    prune(Date.now());
    return [...sessions.values()].map(summarize);
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

/* The hooks that make the above happen. PreToolUse fires with the browser tool's name and the SDK session id —
 * everything needed to name the session and start watching — while the tool itself is still launching Chromium,
 * so the session appears on the rail at the START of the first navigation rather than after it. PostToolUse
 * stamps the clock, which is what keeps a long browsing turn reading as active between attaches.
 *
 * `ports` is the per-turn map browser-tools.ts allocated: server name → the debugging port its Chromium was
 * told to listen on. A tool whose server isn't in it (there is no such call today) simply isn't watched. */
export const browserSessionHooks = (ports: Record<string, number>): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const matcher = "mcp__.+__browser_.+";
    const touch = async (tool: string, sessionId: string): Promise<void> => {
        const server = browserServerOfTool(tool);
        const port = server === undefined ? undefined : ports[server];
        if (server === undefined || port === undefined) {
            return;
        }
        openBrowserSession({ sessionId, server, port });
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
