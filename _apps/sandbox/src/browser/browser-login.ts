import { upgradeWebSocket } from "@hono/node-server";
import type { BrowserPlatform } from "@intentic/sandbox-contract";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { ensureXvfb } from "./display.js";
import { browserProviders } from "./providers.js";
import { acquireLoginLock, markConnected, releaseLoginLock, sessionDir } from "./session-store.js";
import { STEALTH_INIT } from "./stealth.js";
import type { Services } from "../composition.js";

// Fixed screencast viewport — the web canvas scales to it. Modest to bound frame size over the tunnel.
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 800;

// Client → server input frames (JSON, mirrored on the web side — the browser can't import this contract package).
type ClientMessage =
    | {
          readonly type: "mouse";
          readonly action: "move" | "down" | "up" | "wheel";
          readonly x: number;
          readonly y: number;
          readonly button?: number;
          readonly deltaX?: number;
          readonly deltaY?: number;
      }
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "key"; readonly key: string }
    | { readonly type: "resize"; readonly width: number; readonly height: number }
    | { readonly type: "done" }
    | { readonly type: "ping" };

const isBrowserPlatform = (value: string): value is BrowserPlatform => value === "reddit" || value === "x" || value === "youtube";

const cdpButton = (button: number | undefined): "left" | "middle" | "right" => (button === 1 ? "middle" : button === 2 ? "right" : "left");

// The few non-text keys a login form needs; anything printable arrives as a `text` frame (Input.insertText).
const SPECIAL_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Backspace: { code: "Backspace", vk: 8 },
    Tab: { code: "Tab", vk: 9 },
    Delete: { code: "Delete", vk: 46 },
    Escape: { code: "Escape", vk: 27 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
};

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
        let cdp: CDPSession | undefined;
        let closed = false;

        const cleanup = async (): Promise<void> => {
            if (closed) {
                return;
            }
            closed = true;
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
                if (services.auth !== undefined) {
                    try {
                        await services.auth.authorize(url.searchParams.get("token") ?? "", url.searchParams.get("connect") ?? undefined);
                    } catch (err) {
                        services.logger.warn({ err }, "browser-login authorize failed");
                        ws.close(1008, "unauthorized");
                        return;
                    }
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
                        // --no-sandbox: the container is unprivileged and IS the isolation boundary. --disable-dev-shm-usage:
                        // a container's tiny /dev/shm crashes Chromium. The blink flag drops navigator.webdriver.
                        args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
                    });
                    // Patch the residual GPU/WebGL tell (SwiftShader) before the first navigation.
                    await context.addInitScript(STEALTH_INIT);
                    const ctx = context;
                    // (Re)bind the live screencast to one page. OAuth buttons ("Continue with Google") open a POPUP
                    // window; without following it the popup renders off-screen on Xvfb and looks dead. We attach to
                    // the newest page and, when it closes, fall back to the opener (now signed in). onMessage reads
                    // the current `cdp` each message, so mouse/keyboard follow the active page automatically.
                    const startScreencast = async (target: Page): Promise<void> => {
                        try {
                            await cdp?.detach();
                        } catch {
                            // the previous page may already be gone — ignore
                        }
                        const session = await ctx.newCDPSession(target);
                        cdp = session;
                        session.on("Page.screencastFrame", (frame) => {
                            ws.send(JSON.stringify({ type: "frame", data: frame.data }));
                            session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
                        });
                        // Normalize the window so client coords (1280x800) map 1:1 even for a smaller popup.
                        await target.setViewportSize({ width: VIEW_WIDTH, height: VIEW_HEIGHT }).catch(() => {});
                        await session.send("Page.startScreencast", {
                            format: "jpeg",
                            quality: 60,
                            maxWidth: VIEW_WIDTH,
                            maxHeight: VIEW_HEIGHT,
                            everyNthFrame: 1,
                        });
                    };

                    // Follow popups / new tabs to the newest page; on close, return to the opener.
                    ctx.on("page", (popup) => {
                        popup.on("close", () => {
                            const back = ctx.pages().at(-1);
                            if (back !== undefined && !closed) {
                                void startScreencast(back).catch((err: unknown) =>
                                    services.logger.warn({ err }, "browser-login rebind after popup close"),
                                );
                            }
                        });
                        void startScreencast(popup).catch((err: unknown) => services.logger.warn({ err }, "browser-login popup screencast"));
                    });

                    const page = ctx.pages()[0] ?? (await ctx.newPage());
                    await startScreencast(page);
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
                // Capture as a const: `cdp` is a `let` reassigned in onOpen, so TS drops its non-undefined
                // narrowing across the awaits below — the const keeps it.
                const session = cdp;
                if (session === undefined || closed) {
                    return;
                }
                let message: ClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as ClientMessage;
                } catch {
                    return;
                }
                try {
                    if (message.type === "mouse") {
                        if (message.action === "wheel") {
                            await session.send("Input.dispatchMouseEvent", {
                                type: "mouseWheel",
                                x: message.x,
                                y: message.y,
                                deltaX: message.deltaX ?? 0,
                                deltaY: message.deltaY ?? 0,
                            });
                        } else {
                            const type = message.action === "down" ? "mousePressed" : message.action === "up" ? "mouseReleased" : "mouseMoved";
                            await session.send("Input.dispatchMouseEvent", {
                                type,
                                x: message.x,
                                y: message.y,
                                button: cdpButton(message.button),
                                clickCount: message.action === "move" ? 0 : 1,
                            });
                        }
                    } else if (message.type === "text") {
                        await session.send("Input.insertText", { text: message.text });
                    } else if (message.type === "key") {
                        const spec = SPECIAL_KEYS[message.key];
                        if (spec !== undefined) {
                            await session.send("Input.dispatchKeyEvent", {
                                type: spec.text !== undefined ? "keyDown" : "rawKeyDown",
                                key: message.key,
                                code: spec.code,
                                windowsVirtualKeyCode: spec.vk,
                                ...(spec.text !== undefined ? { text: spec.text } : {}),
                            });
                            await session.send("Input.dispatchKeyEvent", {
                                type: "keyUp",
                                key: message.key,
                                code: spec.code,
                                windowsVirtualKeyCode: spec.vk,
                            });
                        }
                    } else if (message.type === "resize") {
                        await session.send("Emulation.setDeviceMetricsOverride", {
                            width: Math.floor(message.width),
                            height: Math.floor(message.height),
                            deviceScaleFactor: 1,
                            mobile: false,
                        });
                    } else if (message.type === "done") {
                        const connected = platform;
                        // Close first so Chromium flushes the profile's cookies to disk, then mark connected.
                        await cleanup();
                        if (connected !== undefined) {
                            await markConnected(services.workspace.root, connected);
                        }
                        ws.send(JSON.stringify({ type: "saved" }));
                        ws.close(1000, "done");
                    }
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
