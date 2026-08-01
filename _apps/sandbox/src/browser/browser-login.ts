import { upgradeWebSocket } from "@hono/node-server";
import type { BrowserPlatform } from "@intentic/sandbox-contract";
import type { BrowserContext } from "playwright";
import { ensureXvfb } from "./display.js";
import { browserProviders } from "./providers.js";
import { dispatchInput, startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type Screencast, type ScreencastClientMessage } from "./screencast.js";
import { acquireLoginLock, markConnected, releaseLoginLock, sessionDir } from "./session-store.js";
import { STEALTH_INIT } from "./stealth.js";
import type { Services } from "../composition.js";
import { redeemTicket } from "../auth/ws-tickets.js";

const isBrowserPlatform = (value: string): value is BrowserPlatform => value === "reddit" || value === "x" || value === "youtube";

// The /system/browser-login route: a guided, live browser sign-in. Like /system/terminal it's a WebSocket the
// header-less browser drives, so it authorizes token+connect from the query string (app.ts exempts it from the
// bearer middleware). The daemon launches a persistent (profile-backed) Chromium at the platform's login page,
// screencasts it to the client, and forwards the owner's mouse/keyboard back over CDP; when the owner clicks
// Done, the profile holds the auth cookies and the session is marked connected so the agent's @playwright/mcp
// reuses it. One login per platform at a time (a persistent profile can't be opened twice).
export const createBrowserLoginRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let platform: BrowserPlatform | undefined;
        let context: BrowserContext | undefined;
        let screencast: Screencast | undefined;
        let closed = false;

        const cleanup = async (): Promise<void> => {
            if (closed) {
                return;
            }
            closed = true;
            await screencast?.stop();
            screencast = undefined;
            try {
                await context?.close();
            } catch (err) {
                services.logger.warn({ err }, "browser-login: context close failed");
            }
            if (platform !== undefined) {
                releaseLoginLock(platform);
            }
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                try {
                    redeemTicket(services, url);
                } catch (err) {
                    services.logger.warn({ err }, "browser-login ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                const requested = url.searchParams.get("platform") ?? "";
                if (!isBrowserPlatform(requested)) {
                    ws.close(1008, "invalid platform");
                    return;
                }
                if (!acquireLoginLock(requested)) {
                    ws.close(1008, "a login for this platform is already in progress");
                    return;
                }
                platform = requested;
                let playwright: typeof import("playwright");
                try {
                    playwright = await import("playwright");
                } catch {
                    ws.send(JSON.stringify({ type: "error", message: "browser not installed — rebuild the sandbox (Environment card) first" }));
                    await cleanup();
                    ws.close(1011, "browser missing");
                    return;
                }
                try {
                    // Run HEADED on a virtual display: the headless shell is fingerprinted and blocked by anti-bot
                    // WAFs (Reddit's "network security"). Xvfb rides the capability's Dockerfile fragment.
                    const display = await ensureXvfb();
                    context = await playwright.chromium.launchPersistentContext(sessionDir(services.workspace.root, platform), {
                        headless: false,
                        env: { ...process.env, DISPLAY: display },
                        viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
                        // Look like a normal desktop browser (headed full Chromium already has a real UA / window.chrome).
                        locale: "en-US",
                        timezoneId: "America/New_York",
                        // --no-sandbox: Chromium runs as root and the container IS the isolation boundary. --disable-dev-shm-usage:
                        // a container's tiny /dev/shm crashes Chromium. The blink flag drops navigator.webdriver.
                        args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
                    });
                    // Patch the residual GPU/WebGL tell (SwiftShader) before the first navigation.
                    await context.addInitScript(STEALTH_INIT);
                    const ctx = context;
                    // A persistent context opens with one page; make sure it exists BEFORE the screencast starts,
                    // so the stream has something to bind to (it follows every later page — popups included —
                    // by itself; see screencast.ts).
                    const page = ctx.pages()[0] ?? (await ctx.newPage());
                    screencast = await startScreencast(ctx, (frame) => ws.send(JSON.stringify({ type: "frame", ...frame })));
                    // Don't hard-fail on a slow login page; the user can still interact once it paints.
                    await page.goto(browserProviders[platform].loginUrl, { waitUntil: "domcontentloaded" }).catch((err: unknown) => {
                        services.logger.warn({ err }, "browser-login initial nav");
                    });
                    ws.send(JSON.stringify({ type: "ready", width: VIEW_WIDTH, height: VIEW_HEIGHT }));
                } catch (err) {
                    services.logger.warn({ err }, "browser-login launch failed");
                    ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "failed to start the browser" }));
                    await cleanup();
                    ws.close(1011, "launch failed");
                }
            },
            onMessage: async (event, ws) => {
                // Read through the screencast each message rather than holding a session: the stream rebinds as
                // popups open and close, so "the page the owner is looking at" is whatever it is attached to now.
                const session = screencast?.attached();
                if (session === undefined || closed) {
                    return;
                }
                let message: ScreencastClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as ScreencastClientMessage;
                } catch {
                    return;
                }
                if (message.type === "done") {
                    const connected = platform;
                    // Close first so Chromium flushes the profile's cookies to disk, then mark connected.
                    await cleanup();
                    if (connected !== undefined) {
                        await markConnected(services.workspace.root, connected);
                    }
                    ws.send(JSON.stringify({ type: "saved" }));
                    ws.close(1000, "done");
                    return;
                }
                try {
                    await dispatchInput(session, message);
                } catch (err) {
                    services.logger.warn({ err }, "browser-login input dispatch failed");
                }
            },
            onClose: () => {
                void cleanup();
            },
            onError: () => {
                void cleanup();
            },
        };
    });
