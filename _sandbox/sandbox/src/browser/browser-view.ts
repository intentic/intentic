import { upgradeWebSocket } from "@hono/node-server";
import { browserSessionContext, browserSessionPage } from "./browser-sessions.js";
import { dispatchInput, startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type Screencast, type ScreencastClientMessage } from "./screencast.js";
import type { Services } from "../composition.js";
import { redeemTicket } from "../auth/ws-tickets.js";

/* The /system/browser-view route: WATCH THE AGENT BROWSE, and take the wheel if you want to.
 *
 * Same wire as /system/browser-profile (a header-less WebSocket authorizing token+connect from the query string;
 * app.ts exempts it from the bearer middleware) and the same frames, because it is the same thing pointed at a
 * different browser: there, the platform's own profile with the owner at the wheel; here, the Chromium the
 * agent is driving through its tools.
 *
 * The stream is READ-ONLY BY DEFAULT — not by refusing input, but because the client sends none until the user
 * asks. That distinction matters: this is the owner's own browser inside the owner's own sandbox, so there is
 * nothing to forbid; what there is, is a default that keeps a click meant for the transcript from landing on the
 * page the agent is mid-way through filling in. When the user does take over (the view's Take control), the
 * frames start flowing and land here unremarked.
 *
 * Closing this socket stops the screencast and nothing else. The browser belongs to the turn, not to the
 * viewer — walking away from the window must not end the work being watched, which is the same contract the
 * terminal panel's attach has with tmux. */
export const createBrowserViewRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let screencast: Screencast | undefined;
        let closed = false;
        let unregisterAccess: (() => void) | undefined;
        // The session this socket watches, read once in onOpen and needed again by every `bind` frame.
        let session = "";

        const cleanup = async (): Promise<void> => {
            if (closed) {
                return;
            }
            closed = true;
            unregisterAccess?.();
            unregisterAccess = undefined;
            await screencast?.stop();
            screencast = undefined;
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                try {
                    // The agent's browser may sit signed in as the owner — taking its wheel is operating,
                    // not watching (a collaborator still sees the agent's own screenshots in the chat).
                    const caller = redeemTicket(services, url, "maintainer");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (err) {
                    services.logger.warn({ err }, "browser-view ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                session = url.searchParams.get("session") ?? "";
                // Awaited, not polled: the user clicks Watch the instant the first tool card appears, which can
                // be ahead of Chromium's first paint — browserSessionContext resolves when the attach lands.
                const context = await browserSessionContext(session);
                if (closed) {
                    return;
                }
                if (context === undefined) {
                    ws.send(JSON.stringify({ type: "error", message: "That browser session is no longer running." }));
                    ws.close(1000, "no session");
                    return;
                }
                try {
                    screencast = await startScreencast(context, (frame) => ws.send(JSON.stringify({ type: "frame", ...frame })));
                    ws.send(JSON.stringify({ type: "ready", width: VIEW_WIDTH, height: VIEW_HEIGHT }));
                } catch (err) {
                    services.logger.warn({ err }, "browser-view screencast failed");
                    ws.send(JSON.stringify({ type: "error", message: "Couldn't attach to that browser." }));
                    await cleanup();
                    ws.close(1011, "screencast failed");
                }
            },
            onMessage: async (event, ws) => {
                if (closed) {
                    return;
                }
                let message: ScreencastClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as ScreencastClientMessage;
                } catch {
                    return;
                }
                if (message.type === "ping") {
                    // The client's keepalive against tunnel idle-reaping; the pong is its read-side liveness
                    // signal, exactly as on the terminal socket (a screencast of a STILL page sends no frames,
                    // so silence here would otherwise be indistinguishable from a half-open connection).
                    // Answered before anything is attached, or a slow Chromium start would read as a dead
                    // socket and the client would tear down the very connection it is waiting on.
                    ws.send(JSON.stringify({ type: "pong" }));
                    return;
                }
                if (message.type === "pause" || message.type === "resume") {
                    // Nobody is looking (hidden tab, another route). Holding the binding but sending nothing is
                    // the whole trick: coming back is one frame away, and a browsing agent stops pushing JPEGs
                    // through the tunnel at an <img> in a background tab.
                    await screencast?.setPaused(message.type === "pause");
                    return;
                }
                if (message.type === "bind") {
                    // The tab strip: stream the page the user clicked, and PIN it so the agent opening another
                    // tab no longer moves the picture. A page id the session doesn't know is a tab that closed
                    // between the relist and the click — say so rather than leaving the strip lying about it.
                    const page = browserSessionPage(session, message.pageId);
                    if (page === undefined) {
                        ws.send(JSON.stringify({ type: "gone", pageId: message.pageId }));
                        return;
                    }
                    await screencast?.bind(page, true);
                    return;
                }
                // Everything left is a pointer or a keystroke, and needs somewhere to land.
                const attached = screencast?.attached();
                if (attached === undefined) {
                    return;
                }
                try {
                    await dispatchInput(attached, message);
                } catch (err) {
                    // A page that navigated out from under the click — the rebind follows it; the input is lost.
                    services.logger.warn({ err }, "browser-view input dispatch failed");
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
