import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrowserSession, listBrowserSessions } from "./browser-sessions.js";
import { OWN_BROWSER_SESSION, openOwnBrowser } from "./own-browser.js";

// The person's own window, started for real: a Chromium on a display of its own, adopted into the session list the
// browser view reads. The first address goes into the tab the window opened on, a later one into a tab of its own, and
// closing it ends the process rather than only letting go of it.

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
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling the session list until the page's address lands
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
