import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSessionFront, browserSessionPage, closeBrowserSession, listBrowserSessions, pickBrowserPage } from "./browser-sessions.js";
import { reopenClosedTab } from "../tabs/browser-tabs.js";
import { OWN_BROWSER_SERVER, OWN_BROWSER_SESSION, openOwnBrowser } from "./own-browser.js";
import { readOwnTabs } from "../tabs/own-tabs.js";
import { isOwnerWindow } from "./owner-browser.js";
import { sessionDir } from "./session-store.js";

// The person's own window, started for real: a Chromium on a display of its own, adopted into the session list the
// browser view reads. The first address goes into the tab the window opened on, a later one into a tab of its own, and
// closing it ends the process rather than only letting go of it. A window that ends without being closed (a crash, a
// restart) comes back with its tabs in order and the right one in front; one closed on purpose comes back empty.

const playwright = await import("playwright").catch(() => undefined);
const installed = playwright !== undefined && existsSync(playwright.chromium.executablePath()) && existsSync("/usr/bin/Xvfb");

let server: Server;
let origin: string;

beforeAll(async () => {
    server = createServer((request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(`<html><head><title>page ${request.url ?? ""}</title></head><body>ok</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
    await closeBrowserSession(OWN_BROWSER_SESSION);
    server.close();
});

const own = () => listBrowserSessions().find((session) => session.name === OWN_BROWSER_SESSION);

const until = async (check: () => boolean, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) {
        // polling the session list until the page's address lands
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
};

test.skipIf(!installed)(
    "the person's window opens, takes tabs, and closes for good",
    async () => {
        const deps = { root: mkdtempSync(join(tmpdir(), "own-browser-")), warn: () => undefined };

        const first = await openOwnBrowser(deps, `${origin}/one`);
        expect(first.name).toBe(OWN_BROWSER_SESSION);
        expect(first.pageId).toEqual(expect.any(String));
        await until(() => own()?.pages.some((page) => page.url === `${origin}/one`) === true);
        expect(own()).toMatchObject({ own: true, running: true });
        // The first address went into the blank tab the window opened on, not beside it.
        expect(own()?.pages).toHaveLength(1);

        const second = await openOwnBrowser(deps, `${origin}/two`);
        expect(second.pageId).toEqual(expect.any(String));
        expect(second.pageId).not.toBe(first.pageId);
        await until(() => own()?.pages.some((page) => page.url === `${origin}/two`) === true);
        expect(own()?.pages.map((page) => page.id)).toEqual([first.pageId ?? "", second.pageId ?? ""]);

        await closeBrowserSession(OWN_BROWSER_SESSION);
        expect(own()?.running).toBe(false);

        // Opened again, the same window name answers with a fresh window.
        const again = await openOwnBrowser(deps, undefined);
        expect(again.name).toBe(OWN_BROWSER_SESSION);
        await until(() => own()?.running === true);
        expect(own()?.pages).toHaveLength(1);
    },
    120_000,
);

// The window's own Chromium, ended the way a daemon restart or a sandbox update ends it: killed, nobody asked.
const killWindow = (root: string): void => {
    const profile = sessionDir(root, OWN_BROWSER_SERVER);
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
        // allow(silent-catch): a process gone between the listing and the read is not the window
        const argv = (() => {
            try {
                return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
            } catch {
                return [];
            }
        })();
        if (isOwnerWindow(argv, profile)) {
            process.kill(Number(pid), "SIGKILL");
        }
    }
};

const historyOf = async (pageId: string): Promise<string[]> => {
    const page = browserSessionPage(OWN_BROWSER_SESSION, pageId);
    if (page === undefined) {
        return [];
    }
    const session = await page.context().newCDPSession(page);
    const { entries } = await session.send("Page.getNavigationHistory");
    await session.detach();
    return entries.map((entry) => entry.url);
};

test.skipIf(!installed)(
    "the window comes back as it stood after an end nobody asked for, and a closed tab comes back with its history",
    async () => {
        // The window the test before left open is another workspace's.
        await closeBrowserSession(OWN_BROWSER_SESSION);
        const root = mkdtempSync(join(tmpdir(), "own-restore-"));
        const deps = { root, warn: () => undefined };
        const one = await openOwnBrowser(deps, `${origin}/one`);
        const two = await openOwnBrowser(deps, `${origin}/two`);
        await openOwnBrowser(deps, `${origin}/three`);
        await until(() => own()?.pages.filter((page) => page.title?.startsWith("page /") === true).length === 3);
        await pickBrowserPage(OWN_BROWSER_SESSION, two.pageId ?? "");
        // Written within a beat.
        await until(() => false, 1500);
        const kept = await readOwnTabs(root);
        expect(kept?.tabs.map((tab) => tab.url)).toEqual([`${origin}/one`, `${origin}/two`, `${origin}/three`]);
        expect(kept?.tabs.map((tab) => tab.title)).toEqual(["page /one", "page /two", "page /three"]);
        expect(kept?.front).toBe(1);
        expect(one.pageId).toEqual(expect.any(String));

        killWindow(root);
        await until(() => own()?.running === false);
        expect(own()?.running).toBe(false);
        // What it had is still kept: nothing is written once the window has gone.
        expect((await readOwnTabs(root))?.tabs).toHaveLength(3);

        const back = await openOwnBrowser(deps, undefined);
        const restored = own();
        expect(restored?.pages.map((page) => page.url)).toEqual([`${origin}/one`, `${origin}/two`, `${origin}/three`]);
        expect(restored?.pages.map((page) => page.title)).toEqual(["page /one", "page /two", "page /three"]);
        const front = restored?.pages.find((page) => page.active);
        expect(front?.url).toBe(`${origin}/two`);
        expect(back.pageId).toBe(front?.id);
        // The picture follows the strip: Chromium has the same tab in front, loaded.
        await until(() => browserSessionFront(OWN_BROWSER_SESSION)?.url() === `${origin}/two`);
        expect(browserSessionFront(OWN_BROWSER_SESSION)?.url()).toBe(`${origin}/two`);
        // The others wait unloaded until picked, and load then.
        const third = restored?.pages[2]?.id ?? "";
        expect(browserSessionPage(OWN_BROWSER_SESSION, third)?.url()).toBe("about:blank");
        await pickBrowserPage(OWN_BROWSER_SESSION, third);
        await until(() => browserSessionPage(OWN_BROWSER_SESSION, third)?.url() === `${origin}/three`);
        expect(browserSessionPage(OWN_BROWSER_SESSION, third)?.url()).toBe(`${origin}/three`);

        // The tab helper is up once every tab says whether it is muted.
        await until(() => own()?.pages.every((page) => page.muted === false) === true);
        expect(own()?.pages.map((page) => page.muted)).toEqual([false, false, false]);

        // A tab that went two places, closed and reopened: back at its place, in front, with both in its history.
        const second = own()?.pages[1]?.id ?? "";
        await browserSessionPage(OWN_BROWSER_SESSION, second)?.goto(`${origin}/two-b`);
        await until(() => own()?.pages[1]?.title === "page /two-b");
        await browserSessionPage(OWN_BROWSER_SESSION, second)?.close();
        await until(() => own()?.closed?.[0]?.url === `${origin}/two-b`);
        expect(own()?.closed?.[0]).toMatchObject({ url: `${origin}/two-b`, title: "page /two-b" });
        const reopened = await reopenClosedTab(OWN_BROWSER_SESSION, undefined);
        expect(reopened.pageId).toEqual(expect.any(String));
        const first = own()?.pages[0]?.id ?? "";
        expect(own()?.pages.map((page) => page.id)).toEqual([first, reopened.pageId ?? "", third]);
        expect(own()?.pages.find((page) => page.active)?.id).toBe(reopened.pageId);
        expect(own()?.closed).toBeUndefined();
        await until(() => browserSessionPage(OWN_BROWSER_SESSION, reopened.pageId ?? "")?.url() === `${origin}/two-b`);
        expect(await historyOf(reopened.pageId ?? "")).toEqual(expect.arrayContaining([`${origin}/two`, `${origin}/two-b`]));

        // Closed on purpose, it forgets.
        await closeBrowserSession(OWN_BROWSER_SESSION);
        expect(await readOwnTabs(root)).toBeUndefined();
    },
    180_000,
);
