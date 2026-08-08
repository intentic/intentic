import { upgradeWebSocket } from "@hono/node-server";
import type { BrowserContext, Page } from "playwright";
import { ensureXvfb } from "./display.js";
import { armPasskeys } from "./passkeys.js";
import { dispatchInput, startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type Screencast, type ScreencastClientMessage } from "./screencast.js";
import { acquireProfileLock, markConnected, passkeyPath, releaseProfileLock, sessionDir } from "./session-store.js";
import { STEALTH_INIT } from "./stealth.js";
import type { Services } from "../composition.js";
import { redeemTicket } from "../auth/ws-tickets.js";
import { contributionKey, contributionRegistry } from "../capabilities/contributions.js";

/* The /system/browser-profile route: THE OWNER'S OWN HANDS ON ONE CONNECTED ACCOUNT'S BROWSER. Like
 * /system/terminal it's a WebSocket the header-less browser drives, so it authorizes token+connect from the
 * query string (app.ts exempts it from the bearer middleware). The daemon launches the persistent
 * (profile-backed) Chromium for one account, screencasts it to the client, and forwards the owner's
 * mouse/keyboard back over CDP.
 *
 * ADDRESSED BY CAPABILITY, NOT BY SITE: the window opens ONE ACCOUNT, and several accounts of one site can be
 * connected at once (reddit-work, reddit-personal). The entry is what the profile is keyed by; the SITE is read
 * back off it, because only the site knows where a sign-in starts and where "home" is.
 *
 * Two modes over one window, because they are the same browser at two moments of its life:
 *   login  — open the site's sign-in page; when the owner clicks Done the profile holds the auth cookies
 *            and the session is marked connected, so the agent's @playwright/mcp reuses it.
 *   browse — open the site's home page in the profile that ALREADY has those cookies. Nothing is marked:
 *            this is the owner using their own connected account by hand (check a message, clear a captcha,
 *            change a setting the agent shouldn't), and a session it cannot judge is not one to re-attest.
 * Browsing needs an address bar, which a screencast of the page alone can't provide (there is no window chrome
 * in the picture) — hence the `go`/`back`/`reload` frames and the `url` frames going the other way.
 *
 * One window per ACCOUNT at a time (a persistent profile can't be opened twice) — the same lock that parks the
 * agent's browser tools for that account while the owner has the wheel, and the reason the owner can sit in one
 * Reddit account by hand while the agent works in the other. */
export const createBrowserProfileRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        // The capability id of the account this window drives — the profile's key, and the lock's.
        let account: string | undefined;
        let context: BrowserContext | undefined;
        let screencast: Screencast | undefined;
        let closed = false;
        // Whether finishing means "this account is now connected" (login) or just "close the window" (browse).
        let signingIn = true;

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
                services.logger.warn({ err }, "browser-profile: context close failed");
            }
            if (account !== undefined) {
                releaseProfileLock(account);
            }
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                try {
                    // Signing a live Chromium into a service ADDS a credential, and browsing it is acting AS the
                    // owner in their own account — the owner's tier alone, like everything else on the
                    // capabilities surface.
                    redeemTicket(services, url, "owner");
                } catch (err) {
                    services.logger.warn({ err }, "browser-profile ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                // An account is real iff the manifest holds a browser entry with that id — the profile this
                // window opens IS that entry's, so an id nobody added has no profile to open.
                const requested = url.searchParams.get("capability") ?? "";
                const capability = await services.capabilities.get(requested);
                if (capability === undefined || capability.kind !== "browser") {
                    ws.close(1008, "invalid capability");
                    return;
                }
                // Its SITE is where the sign-in and the home page live — real iff an enabled extension declares
                // it, the same registry the browser handler resolves against.
                const contribution = (await contributionRegistry(services)).get(contributionKey("browser", capability.config.platform));
                if (contribution === undefined || contribution.spec.kind !== "browser") {
                    ws.close(1008, "invalid platform");
                    return;
                }
                signingIn = url.searchParams.get("mode") !== "browse";
                // Signed in, a login page only bounces to the feed — so a browse window starts where the owner
                // means to be. The two are separate manifest fields because some platforms sign in on another
                // site entirely (YouTube at accounts.google.com).
                const startUrl = signingIn ? contribution.spec.loginUrl : contribution.spec.homeUrl;
                if (!acquireProfileLock(requested)) {
                    ws.close(1008, "this browser is already open in another window");
                    return;
                }
                account = requested;
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
                    context = await playwright.chromium.launchPersistentContext(sessionDir(services.workspace.root, account), {
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
                    // The sandbox's software security key for THIS ACCOUNT, plugged in BEFORE the first
                    // navigation: this window is where the owner enrolls it (a site's "Add security key" lands on
                    // the virtual authenticator and persists) and where a stored one answers a 2FA prompt. Two
                    // accounts of one site enroll their own, as they would on two physical keys.
                    const storePath = passkeyPath(services.workspace.root, account);
                    const arm = (target: Page): void =>
                        void armPasskeys(ctx, target, storePath).catch((err: unknown) =>
                            services.logger.warn({ err }, "browser-profile: passkey arm failed"),
                        );
                    ctx.on("page", arm);
                    arm(page);
                    // WHERE THE ADDRESS BAR GETS ITS TEXT. Read off the STREAMED page rather than the one that
                    // fired the event, because a popup moves the picture: what the field must show is the page
                    // being looked at. Same-document navigations count — an SPA's own routing is most of what
                    // moves on these sites.
                    const report = (): void => {
                        const current = screencast?.page()?.url();
                        if (current !== undefined && !closed) {
                            ws.send(JSON.stringify({ type: "url", url: current }));
                        }
                    };
                    const watch = (target: Page): void => {
                        target.on("framenavigated", (frame) => {
                            if (frame === target.mainFrame()) {
                                report();
                            }
                        });
                    };
                    ctx.on("page", watch);
                    watch(page);
                    screencast = await startScreencast(ctx, (frame) => ws.send(JSON.stringify({ type: "frame", ...frame })));
                    // Don't hard-fail on a slow page; the user can still interact once it paints.
                    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch((err: unknown) => {
                        services.logger.warn({ err }, "browser-profile initial nav");
                    });
                    ws.send(JSON.stringify({ type: "ready", width: VIEW_WIDTH, height: VIEW_HEIGHT }));
                    report();
                } catch (err) {
                    services.logger.warn({ err }, "browser-profile launch failed");
                    ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "failed to start the browser" }));
                    await cleanup();
                    ws.close(1011, "launch failed");
                }
            },
            onMessage: async (event, ws) => {
                // Read through the screencast each message rather than holding a session: the stream rebinds as
                // popups open and close, so "the page the owner is looking at" is whatever it is attached to now.
                const view = screencast;
                const session = view?.attached();
                if (view === undefined || session === undefined || closed) {
                    return;
                }
                let message: ScreencastClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as ScreencastClientMessage;
                } catch {
                    return;
                }
                if (message.type === "done") {
                    const finished = account;
                    // Close first so Chromium flushes the profile's cookies to disk, then mark connected — a
                    // browse window changes nothing about whether the account is connected, so it only closes.
                    await cleanup();
                    if (signingIn && finished !== undefined) {
                        await markConnected(services.workspace.root, finished);
                    }
                    ws.send(JSON.stringify({ type: "saved" }));
                    ws.close(1000, "done");
                    return;
                }
                // The address bar's three buttons. Driven through Playwright rather than raw CDP so a navigation
                // that hangs gives up on its own instead of leaving the click looking ignored; each is best-effort
                // for the same reason the initial goto is (a slow site is still usable once it paints).
                if (message.type === "go" || message.type === "back" || message.type === "reload") {
                    const page = view.page();
                    if (page === undefined) {
                        return;
                    }
                    const navigation =
                        message.type === "go"
                            ? page.goto(message.url, { waitUntil: "domcontentloaded" })
                            : message.type === "back"
                              ? page.goBack({ waitUntil: "domcontentloaded" })
                              : page.reload({ waitUntil: "domcontentloaded" });
                    await navigation.catch((err: unknown) => services.logger.warn({ err }, "browser-profile navigation failed"));
                    return;
                }
                try {
                    await dispatchInput(session, message);
                } catch (err) {
                    services.logger.warn({ err }, "browser-profile input dispatch failed");
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
