import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import type { BrowserContext, Page } from "playwright";
import { chromiumWindowArgs, ensureDisplay, releaseDisplay } from "../cast/display.js";
import { adoptBrowserSession, browserSessionState, closeBrowserSession, pickBrowserPage } from "../sessions/browser-sessions.js";
import { streamWindow } from "./window-feed.js";

// One window's state against a real Chromium headed on Xvfb, as the daemon's own windows run: which tab is in front
// when the person picks one and when something outside the daemon switches tabs, what each tab's history allows, and
// that every change reaches a watching socket with a higher seq. Skips where the browser pack is not installed.

const DISPLAY_KEY = "window-state-test";
const NAME = "browser-statetst";

// Polls for a condition rather than sleeping a guess; generous but finite, so a regression fails rather than hangs.
const settle = async (until: () => boolean, ms = 15_000): Promise<void> => {
    for (let waited = 0; waited < ms && !until(); waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const launch = async (): Promise<{ context: BrowserContext; profile: string; port: number } | undefined> => {
    let playwright: typeof import("playwright");
    try {
        playwright = await import("playwright");
    } catch {
        return undefined; // the package isn't installed
    }
    const executablePath = playwright.chromium.executablePath();
    const display = existsSync(executablePath) ? await ensureDisplay(DISPLAY_KEY).catch(() => undefined) : undefined;
    if (display === undefined) {
        return undefined; // no Chromium or no Xvfb on this box
    }
    const profile = mkdtempSync(join(tmpdir(), "window-state-test-"));
    const context = await playwright.chromium
        .launchPersistentContext(profile, {
            executablePath,
            headless: false,
            viewport: null,
            env: { ...process.env, DISPLAY: display.name },
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", ...chromiumWindowArgs(display)],
        })
        .catch(() => undefined);
    if (context === undefined) {
        rmSync(profile, { recursive: true, force: true });
        return undefined;
    }
    const file = join(profile, "DevToolsActivePort");
    await settle(() => existsSync(file) && readFileSync(file, "utf8").includes("\n"));
    return { context, profile, port: Number(readFileSync(file, "utf8").split("\n")[0]) };
};

const site = async (): Promise<{ server: Server; url: (path: string) => string }> => {
    const server = createServer((request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(`<title>at ${request.url ?? ""}</title><body>${request.url ?? ""}</body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    const { port } = server.address() as { port: number };
    return { server, url: (path) => `http://127.0.0.1:${port}${path}` };
};

const pageIdOf = (window: BrowserSession | undefined, url: string): string | undefined => window?.pages.find((page) => page.url === url)?.id;
const frontOf = (window: BrowserSession | undefined): string | undefined => window?.pages.find((page) => page.active)?.id;

test(
    "the tab in front, each tab's history and every change reach a watching socket, newest last",
    async () => {
        const launched = await launch();
        if (launched === undefined) {
            return; // no browser on this box
        }
        const { context, profile, port } = launched;
        const http = await site();
        const streamed: BrowserSession[] = [];
        let stopStream: (() => void) | undefined;
        try {
            const older = context.pages()[0] ?? (await context.newPage());
            await older.goto(http.url("/a"));
            adoptBrowserSession({ name: NAME, server: "web", context, shutdown: () => context.close(), port });
            stopStream = streamWindow(NAME, () => browserSessionState(NAME), (window) => streamed.push(window));
            const newer: Page = await context.newPage();
            await newer.goto(http.url("/n"));

            // The tab that opened last is the one Chromium shows, and the window says so.
            await settle(() => frontOf(browserSessionState(NAME)) === pageIdOf(browserSessionState(NAME), http.url("/n")));
            const olderId = pageIdOf(browserSessionState(NAME), http.url("/a"));
            const newerId = pageIdOf(browserSessionState(NAME), http.url("/n"));
            expect(olderId).toEqual(expect.any(String));
            expect(frontOf(browserSessionState(NAME))).toBe(newerId);

            // A person's pick is in front at once, for everyone, before Chromium is asked again.
            const seqBefore = browserSessionState(NAME)?.seq ?? 0;
            await pickBrowserPage(NAME, olderId ?? "");
            expect(frontOf(browserSessionState(NAME))).toBe(olderId);
            const picked = browserSessionState(NAME)?.seq ?? 0;
            expect(picked).toBeGreaterThan(seqBefore);
            // The socket's copy catches up within its send window, as the window stood at the pick or later.
            await settle(() => (streamed.at(-1)?.seq ?? 0) >= picked);
            expect(frontOf(streamed.at(-1))).toBe(olderId);

            // Switched from outside the daemon (an agent's own Playwright): nothing tells the window, and the reader's
            // backstop finds it while someone is watching.
            await newer.bringToFront();
            await settle(() => frontOf(browserSessionState(NAME)) === newerId, 8_000);
            expect(frontOf(browserSessionState(NAME))).toBe(newerId);
            const switched = browserSessionState(NAME)?.seq ?? 0;
            await settle(() => (streamed.at(-1)?.seq ?? 0) >= switched);
            expect(frontOf(streamed.at(-1))).toBe(newerId);

            // History, as the browser's own back and forward buttons would show it.
            await older.goto(http.url("/b"));
            const historyOf = (): BrowserSession["pages"][number] | undefined => browserSessionState(NAME)?.pages.find((page) => page.id === olderId);
            await settle(() => historyOf()?.canGoBack === true);
            expect(historyOf()).toMatchObject({ canGoBack: true, canGoForward: false });
            // Back to /a, which still has the tab's first page, about:blank, behind it.
            await older.goBack();
            await settle(() => historyOf()?.canGoForward === true);
            expect(historyOf()).toMatchObject({ url: http.url("/a"), canGoBack: true, canGoForward: true });

            // The tab in front closing leaves the other in front.
            await newer.close();
            await settle(() => frontOf(browserSessionState(NAME)) === olderId);
            expect(frontOf(browserSessionState(NAME))).toBe(olderId);

            // Every copy a socket got is newer than the one before it.
            const seqs = streamed.map((window) => window.seq ?? 0);
            expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
            expect(new Set(seqs).size).toBe(seqs.length);
        } finally {
            stopStream?.();
            await closeBrowserSession(NAME);
            http.server.close();
            releaseDisplay(DISPLAY_KEY);
            rmSync(profile, { recursive: true, force: true });
        }
    },
    { timeout: 120_000 },
);
