import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import type { WSContext } from "hono/ws";
import type { BrowserContext, Page } from "playwright";
import { ensureDisplay } from "../cast/display.js";
import { startLiveView, type LiveView } from "../cast/live-view.js";
import { armPasskeys } from "../tools/passkeys.js";
import type { ScreencastClientMessage } from "../cast/screencast.js";
import { resolveProfileExit } from "./browser-exit.js";
import { acceptLanguage, browserFingerprint } from "./fingerprint.js";
import { acquireProfileLock, markConnected, passkeyPath, profileOwner, releaseProfileLock, sessionDir } from "./session-store.js";
import { stealthInit } from "./stealth.js";
import type { Services } from "../../composition.js";
import { redeemTicket } from "../../auth/ws-tickets.js";
import { browserUrls, contributionKey, contributionRegistry } from "../../capabilities/contributions.js";
import { identityLoginUrl } from "../../capabilities/handlers/identity.handler.js";

type Socket = WSContext;

// WebSocket route opening one connected account's or identity's browser window in profileOwner's persistent profile;
// authorized via token+connect query params, exempt from bearer middleware. An identity's accounts share one browser.
// login: opens the sign-in page; marks the session connected when the owner finishes.
// browse: opens the home page in an already-signed-in profile; marks nothing.
export const createBrowserProfileRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        // Capability id of the entry this window drives; marked connected on done.
        let account: string | undefined;
        // profileOwner of the entry; the session dir, passkeys and lock are keyed to it.
        let owner: string | undefined;
        let context: BrowserContext | undefined;
        let view: LiveView | undefined;
        let closed = false;
        let unregisterAccess: (() => void) | undefined;
        // True for login mode (finishing marks the account connected); false for browse (finishing just closes).
        let signingIn = true;

        const cleanup = async (): Promise<void> => {
            if (closed) {
                return;
            }
            closed = true;
            unregisterAccess?.();
            unregisterAccess = undefined;
            await view?.stop();
            view = undefined;
            try {
                await context?.close();
            } catch (err) {
                services.logger.warn({ err }, "browser-profile: context close failed");
            }
            if (owner !== undefined) {
                releaseProfileLock(owner);
            }
        };

        // Closes before marking connected so Chromium flushes cookies to disk first; browse mode only closes.
        const onDone = async (ws: Socket): Promise<void> => {
            const finished = account;
            await cleanup();
            if (signingIn && finished !== undefined) {
                await markConnected(services.workspace.root, finished);
            }
            ws.send(JSON.stringify({ type: "saved" }));
            ws.close(1000, "done");
        };

        // Window-level messages (finishing, clipboard) only; the picture is the whole display, so the address bar and
        // any drop-down are clickable directly, not redrawn.
        const handleWindow = async (message: ScreencastClientMessage, ws: Socket): Promise<boolean> => {
            if (message.type === "done") {
                await onDone(ws);
                return true;
            }
            if (message.type === "selection") {
                // Always replies, even empty: client blocks the keystroke until this response arrives.
                ws.send(JSON.stringify({ type: "selection", text: (await view?.selection()) ?? "" }));
                return true;
            }
            return false;
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                try {
                    // Signing in adds a credential: requires the operating tier.
                    const caller = redeemTicket(services, url, "maintainer");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (err) {
                    services.logger.warn({ err }, "browser-profile ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                // Valid only if the manifest has a browser/identity entry with this id; an unlisted id has no profile
                // to open.
                const requested = url.searchParams.get("capability") ?? "";
                const capability = await services.capabilities.get(requested);
                if (capability === undefined || (capability.kind !== "browser" && capability.kind !== "identity")) {
                    ws.close(1008, "invalid capability");
                    return;
                }
                let urls: { loginUrl: string; homeUrl: string };
                if (capability.kind === "browser") {
                    // Requires an enabled extension declaring this platform; same registry the browser handler resolves
                    // against.
                    const contribution = (await contributionRegistry(services)).get(contributionKey("browser", capability.config.platform));
                    if (contribution === undefined || contribution.spec.kind !== "browser") {
                        ws.close(1008, "invalid platform");
                        return;
                    }
                    // A missing pair means a rotted install: the entry's add would otherwise have failed.
                    const resolved = browserUrls(contribution.spec, capability.config);
                    if (resolved === undefined) {
                        ws.close(1008, "this connection has no page to open: re-add it");
                        return;
                    }
                    urls = resolved;
                } else {
                    // An identity's site is its own email provider; login and browse both start at its landing page.
                    const login = identityLoginUrl(capability.config);
                    urls = { loginUrl: login, homeUrl: login };
                }
                signingIn = url.searchParams.get("mode") !== "browse";
                // loginUrl and homeUrl can differ: sites like YouTube sign in on a different domain than their home
                // page.
                const startUrl = signingIn ? urls.loginUrl : urls.homeUrl;
                const profile = profileOwner(capability);
                if (!acquireProfileLock(profile)) {
                    ws.close(1008, "this browser is already open in another window");
                    return;
                }
                account = requested;
                owner = profile;
                // Refuses to open if the bound exit can't be resolved, rather than logging in from the sandbox's own
                // address.
                const bound = await resolveProfileExit(await services.capabilities.list(), profile).catch((error: unknown) => ({
                    refusal: `its exit could not be resolved (${errorMessage(error)})`,
                }));
                if (bound !== undefined && "refusal" in bound) {
                    ws.send(JSON.stringify({ type: "error", message: bound.refusal }));
                    await cleanup();
                    ws.close(1011, "exit unavailable");
                    return;
                }
                const boundExit = bound?.exit;
                let playwright: typeof import("playwright");
                try {
                    playwright = await import("playwright");
                } catch {
                    ws.send(JSON.stringify({ type: "error", message: "browser not installed, rebuild the sandbox (Environment card) first" }));
                    await cleanup();
                    ws.close(1011, "browser missing");
                    return;
                }
                try {
                    // Headed, not headless: anti-bot WAFs block it, and the display is the owner's picture, so it's
                    // exclusive.
                    const display = await ensureDisplay(profile);
                    // Same seed as the agent's browser fingerprint: a device change mid-session triggers a logout or
                    // captcha.
                    const fingerprint = await browserFingerprint(services.workspace.root, profile, boundExit?.place);
                    context = await playwright.chromium.launchPersistentContext(sessionDir(services.workspace.root, profile), {
                        headless: false,
                        env: { ...process.env, DISPLAY: display.name },
                        // null: page fills the window exactly, so picture coordinates map directly to XTEST clicks on
                        // the display.
                        viewport: null,
                        // From the fingerprint's place: a bound profile claims its exit's country, unbound claims the
                        // sandbox's.
                        locale: fingerprint.locale,
                        timezoneId: fingerprint.timezoneId,
                        // Explicit: deriving from locale alone would contradict the multi-tag navigator.languages set
                        // below.
                        extraHTTPHeaders: { "Accept-Language": acceptLanguage(fingerprint.languages) },
                        // Must match locale/timezoneId above: an IP in Berlin under a New York clock is worse than no
                        // exit at all.
                        ...(boundExit === undefined ? {} : { proxy: { server: boundExit.proxy } }),
                        // --no-sandbox: container is the isolation boundary, running as root.
                        // --disable-dev-shm-usage: avoids crashing on a container's tiny /dev/shm.
                        // --disable-blink-features=AutomationControlled: drops navigator.webdriver.
                        // --window-position=0,0: pins the window so a screen grab is exactly this window (no window
                        // manager on Xvfb).
                        args: [
                            "--no-sandbox",
                            "--disable-blink-features=AutomationControlled",
                            "--disable-dev-shm-usage",
                            "--window-position=0,0",
                            `--window-size=${display.width},${display.height}`,
                        ],
                    });
                    // Patches residual server tells (SwiftShader GPU, host core count) before first navigation.
                    await context.addInitScript(stealthInit(fingerprint));
                    const ctx = context;
                    // Ensures a page exists before the screencast starts; it then follows later pages and popups on its
                    // own.
                    const page = ctx.pages()[0] ?? (await ctx.newPage());
                    // Security key armed before first navigation; an identity's accounts share one key, as they share
                    // cookies.
                    const storePath = passkeyPath(services.workspace.root, profile);
                    const arm = (target: Page): void =>
                        void armPasskeys(ctx, target, storePath).catch((err: unknown) =>
                            services.logger.warn({ err }, "browser-profile: passkey arm failed"),
                        );
                    ctx.on("page", arm);
                    arm(page);
                    view = await startLiveView(ctx, profile, { send: (data) => ws.send(data) }, (reason) => {
                        services.logger.warn({ reason }, "browser-profile stream failed");
                    });
                    // Doesn't fail on a slow page; the owner can interact once it paints.
                    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch((err: unknown) => {
                        services.logger.warn({ err }, "browser-profile initial nav");
                    });
                } catch (err) {
                    services.logger.warn({ err }, "browser-profile launch failed");
                    ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "failed to start the browser" }));
                    await cleanup();
                    ws.close(1011, "launch failed");
                }
            },
            onMessage: async (event, ws) => {
                if (view === undefined || closed) {
                    return;
                }
                let message: ScreencastClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as ScreencastClientMessage;
                } catch {
                    return;
                }
                // Window-level messages first; anything unclaimed is pointer/keystroke input for live-view to route.
                if (!(await handleWindow(message, ws))) {
                    await view.input(message);
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
