import { upgradeWebSocket } from "@hono/node-server";
import type { WSContext } from "hono/ws";
import { browserSessionContext, browserSessionDisplayKey, browserSessionPage } from "../sessions/browser-sessions.js";
import { startLiveView, type LiveView } from "./live-view.js";
import type { ScreencastClientMessage } from "./screencast.js";
import type { Services } from "../../composition.js";
import { redeemTicket } from "../../auth/ws-tickets.js";

// The socket the handlers below answer on, named once so each of them does not repeat hono's generic.
type Socket = WSContext;

// /system/browser-view: watches the agent's browser, and lets the user take the wheel. Same wire and pictures as
// /system/browser-profile, pointed at a different browser. Read-only only because the client sends no input until the
// user takes over; closing the socket stops the picture, not the turn's browser.
export const createBrowserViewRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let view: LiveView | undefined;
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
            await view?.stop();
            view = undefined;
        };

        // Tab strip only the frames path needs: a screencast shows one page, so picking matters, while video shows the
        // whole window with its own strip. `bind` answers either way; an unknown page id means the tab closed since the
        // relist.
        const onBind = async (pageId: string, ws: Socket): Promise<void> => {
            const page = browserSessionPage(session, pageId);
            if (page === undefined) {
                ws.send(JSON.stringify({ type: "gone", pageId }));
                return;
            }
            await view?.bind(page);
        };

        // Ctrl+C over the picture: returns what the page selected so the client can put it on the local clipboard.
        // Answered even when empty, since the client waits on it before releasing the keystroke.
        const onSelection = async (ws: Socket): Promise<void> => {
            ws.send(JSON.stringify({ type: "selection", text: (await view?.selection()) ?? "" }));
        };

        // Conversation-level half of this socket (keepalive, streaming, selection, visibility), split from the input
        // half: this one answers for the view, not the browser. Returns whether it handled the frame.
        const handleControl = async (message: ScreencastClientMessage, ws: Socket): Promise<boolean> => {
            switch (message.type) {
                case "ping":
                    // Keepalive against tunnel idle-reaping, answered before attach so a slow start isn't read as a
                    // dead socket.
                    ws.send(JSON.stringify({ type: "pong" }));
                    return true;
                case "pause":
                case "resume":
                    // Nobody is looking: video kills the encoder outright; frames just holds the binding, sending
                    // nothing.
                    await view?.setPaused(message.type === "pause");
                    return true;
                case "bind":
                    await onBind(message.pageId, ws);
                    return true;
                case "selection":
                    await onSelection(ws);
                    return true;
                case "selectOption":
                    // The owner picked from a menu the CLIENT drew, which only ever happens on the frames path.
                    await view?.chooseOption(message.index);
                    return true;
                default:
                    return false;
            }
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                try {
                    // The agent's browser may be signed in as the owner; taking the wheel is operating, not watching.
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
                // Awaited, not polled: a click can arrive before Chromium's first paint; this resolves once the attach
                // lands.
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
                    // Display key decides video vs frames; a headless session has none, so frames answers instead.
                    view = await startLiveView(context, browserSessionDisplayKey(session) ?? "", { send: (data) => ws.send(data) }, (reason) => {
                        services.logger.warn({ reason }, "browser-view stream failed");
                    });
                } catch (err) {
                    services.logger.warn({ err }, "browser-view attach failed");
                    ws.send(JSON.stringify({ type: "error", message: "Couldn't attach to that browser." }));
                    await cleanup();
                    ws.close(1011, "attach failed");
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
                // Control first; whatever it does not claim is a pointer or a keystroke for the browser.
                if (!(await handleControl(message, ws))) {
                    await view?.input(message);
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
