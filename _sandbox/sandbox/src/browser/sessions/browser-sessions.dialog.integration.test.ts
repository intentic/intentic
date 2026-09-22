import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { test, expect } from "bun:test";
import { answerBrowserDialog, browserSessionContext, closeBrowserSession, listBrowserSessions, openBrowserSession } from "./browser-sessions.js";

// A Playwright client dismisses any dialog nobody listens for, and this daemon attaches to the agent's browser as a
// second client: before the session held dialogs, every alert the agent's page opened was closed by the daemon the
// moment it attached, and browser_handle_dialog had nothing to handle. The browser here is launched the way the
// MCP launches it (a debugging port the daemon attaches to), and the page is driven by the launching client, the
// agent's role.

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
        });
    });

const launch = async (port: number): Promise<{ context: BrowserContext; profile: string } | undefined> => {
    let playwright: typeof import("playwright");
    try {
        playwright = await import("playwright");
    } catch {
        return undefined;
    }
    const executablePath = playwright.chromium.executablePath();
    if (!existsSync(executablePath)) {
        return undefined;
    }
    const profile = mkdtempSync(join(tmpdir(), "dialog-test-"));
    const context = await playwright.chromium
        .launchPersistentContext(profile, {
            executablePath,
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", `--remote-debugging-port=${port}`],
        })
        .catch(() => undefined);
    if (context === undefined) {
        rmSync(profile, { recursive: true, force: true });
        return undefined;
    }
    return { context, profile };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test(
    "a dialog the agent's page opens is held for whoever answers, not dismissed by the daemon's own attach",
    async () => {
        const port = await freePort();
        const launched = await launch(port);
        if (launched === undefined) {
            return; // no browser on this box
        }
        const { context, profile } = launched;
        const name = openBrowserSession({ sessionId: "d1a10900-0000-4000-8000-000000000001", server: "web", port });
        expect(name).toEqual(expect.stringMatching(/^browser-/));
        try {
            // Attached: the daemon's client sees the persistent context's one initial page.
            const attached = await browserSessionContext(name!);
            expect(attached?.pages()).toHaveLength(1);
            const page = context.pages()[0] ?? (await context.newPage());
            // The agent's client holds its dialogs for browser_handle_dialog, as @playwright/mcp does with a listener of
            // its own; without one this client would dismiss its own alert, and the daemon's attach would never be the
            // question.
            page.on("dialog", () => {});
            await page.goto("data:text/html,<title>d</title>ok");
            // A settled attach, with the daemon's own dialog listener registered before anything opens.
            await sleep(300);

            const outcome = page.evaluate(() => alert("held")).then(() => "closed" as const);
            // Held: a second later the alert is still open, and the session says so.
            expect(await Promise.race([outcome, sleep(1500).then(() => "open" as const)])).toBe("open");
            const listed = listBrowserSessions().find((session) => session.name === name);
            expect(listed?.dialog).toMatchObject({ kind: "alert", message: "held" });

            // The owner answers over the view; the page's alert returns and the session no longer lists it.
            await answerBrowserDialog(name!, true);
            expect(await outcome).toBe("closed");
            await sleep(300);
            expect(listBrowserSessions().find((session) => session.name === name)?.dialog).toBeUndefined();
        } finally {
            await closeBrowserSession(name!);
            await context.close().catch(() => undefined);
            rmSync(profile, { recursive: true, force: true });
        }
    },
    { timeout: 90_000 },
);
