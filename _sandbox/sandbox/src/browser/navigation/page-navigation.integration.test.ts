import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@intentic/base/fs";
import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { requires } from "@intentic/testing/requires";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "playwright";
import { browserSessionContext, browserSessionPage, closeBrowserSession, listBrowserSessions, openBrowserSession } from "../sessions/browser-sessions.js";
import { stopLoading } from "./page-navigation.js";

// What the Browsers view draws between two addresses, read off a real Chromium: the daemon attaches to it as it does to
// an agent's browser, and the page is driven by the launching client, the agent's role. A host that takes the request
// and never answers is the case that looked like a dead click (2026-11-18): the roster has to say the tab is waiting,
// on which host, and the stop button has to end it.

const playwright = await import("playwright").catch(() => undefined);
const chromium = requires(
    playwright !== undefined && existsSync(playwright.chromium.executablePath()),
    "Playwright's Chromium (playwright install chromium)",
    { absentOnCi: "no CI job that runs the daemon's suites installs the browser pack; the sandbox image carries it" },
);

const launch = async (port: number): Promise<{ context: BrowserContext; profile: string }> => {
    if (playwright === undefined) {
        throw new Error("playwright is not installed");
    }
    const profile = mkdtempSync(join(tmpdir(), "navigation-test-"));
    const context = await playwright.chromium.launchPersistentContext(profile, {
        executablePath: playwright.chromium.executablePath(),
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", `--remote-debugging-port=${port}`],
    });
    return { context, profile };
};

// A site with a page that answers, one that never does, and a redirect onto the one that never does.
const startSite = async (): Promise<{ server: Server; origin: string }> => {
    const server = createServer((request, response) => {
        if (request.url === "/hang") {
            return; // taken and never answered, the way a host behind a dead route behaves
        }
        if (request.url === "/redirect") {
            response.writeHead(302, { location: "/hang" }).end();
            return;
        }
        response.end("<title>Arrived</title>here");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: a server listening on a TCP port answers address() with its AddressInfo; only a pipe answers a string.
    const { port } = server.address() as AddressInfo;
    return { server, origin: `http://127.0.0.1:${port}` };
};

// Polls the roster for a real change instead of sleeping a guess; capped so a regression fails on the assertion.
const pageWhen = async (name: string, until: (page: BrowserPage) => boolean): Promise<BrowserPage | undefined> => {
    const listed = (): BrowserPage | undefined => listBrowserSessions().find((session) => session.name === name)?.pages[0];
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const page = listed();
        if (page !== undefined && until(page)) {
            return page;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return listed();
};

// Sent on its way and left there: the agent's goto would wait on the hanging host for its whole timeout.
const sendTo = (page: Page, url: string): void => {
    void page.goto(url, { timeout: 60_000 }).catch(() => undefined);
};

test.skipIf(!chromium.runs)(
    chromium.title("a tab waiting on a host says so, on which host since when, until it is stopped, arrives or fails"),
    async () => {
        const port = await freePort();
        const { context, profile } = await launch(port);
        const { server, origin } = await startSite();
        const refused = await freePort();
        const name = openBrowserSession({ sessionId: "4a710000-0000-4000-8000-000000000001", server: "web", port });
        try {
            // Asked, not matched: toMatchObject writes its matcher onto the live context, whose pages() the daemon
            // still calls.
            expect((await browserSessionContext(name!))?.pages()).toEqual(expect.any(Array));
            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto(`${origin}/start`);
            await pageWhen(name!, (listed) => listed.url === `${origin}/start` && listed.loading !== true);

            // A redirect onto a host that never answers: the tab waits on the hop it is at now.
            const setOff = Date.now();
            sendTo(page, `${origin}/redirect`);
            const waiting = await pageWhen(name!, (listed) => listed.navigation?.url === `${origin}/hang`);
            expect(waiting).toMatchObject({ url: `${origin}/start`, loading: true, navigation: { url: `${origin}/hang` } });
            expect(waiting?.navigation?.since).toBeGreaterThanOrEqual(setOff - 1_000);

            // The stop button ends it, and the tab rests on the page it never left.
            const daemonPage = browserSessionPage(name!, waiting?.id ?? "");
            if (daemonPage === undefined) {
                throw new Error(`the daemon holds no page ${waiting?.id ?? "(none listed)"} in ${name!}`);
            }
            await stopLoading(daemonPage);
            // Its title is read again once it rests: one read on the way would have been Playwright's "Loading <url>".
            const stopped = await pageWhen(name!, (listed) => listed.loading !== true && listed.title !== undefined);
            expect(stopped).toEqual({ id: "p1", url: `${origin}/start`, title: "Arrived", active: true, canGoBack: true, canGoForward: false });

            // A port nobody listens on: Chromium's error page, listed under the address that failed and why.
            sendTo(page, `http://127.0.0.1:${refused}/`);
            const failed = await pageWhen(name!, (listed) => listed.error !== undefined && listed.loading !== true);
            expect(failed).toMatchObject({ url: `http://127.0.0.1:${refused}/`, error: "net::ERR_CONNECTION_REFUSED" });
            expect(failed?.navigation).toBeUndefined();

            // Arriving anywhere else forgets the failure.
            await page.goto(`${origin}/again`);
            const arrived = await pageWhen(name!, (listed) => listed.url === `${origin}/again` && listed.loading !== true && listed.title !== undefined);
            // Its history reaches back past /start to the tab's first page, about:blank.
            expect(arrived).toEqual({ id: "p1", url: `${origin}/again`, title: "Arrived", active: true, canGoBack: true, canGoForward: false });
        } finally {
            await closeBrowserSession(name!);
            await context.close().catch(() => undefined);
            server.closeAllConnections();
            server.close();
            rmSync(profile, { recursive: true, force: true });
        }
    },
    60_000,
);
