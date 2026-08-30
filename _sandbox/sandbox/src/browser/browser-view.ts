import { upgradeWebSocket } from "@hono/node-server";
import type { WSContext } from "hono/ws";
import { browserSessionContext, browserSessionDisplayKey, browserSessionPage } from "./browser-sessions.js";
import { startLiveView, type LiveView } from "./live-view.js";
import type { ScreencastClientMessage } from "./screencast.js";
import type { Services } from "../composition.js";
import { redeemTicket } from "../auth/ws-tickets.js";

// The socket the handlers below answer on, named once so each of them does not repeat hono's generic.
type Socket = WSContext;

/* The /system/browser-view route: WATCH THE AGENT BROWSE, and take the wheel if you want to.
 *
 * Same wire as /system/browser-profile (a header-less WebSocket authorizing token+connect from the query string;
 * app.ts exempts it from the bearer middleware) and the same pictures, because it is the same thing pointed at a
 * different browser: there, the platform's own profile with the owner at the wheel; here, the Chromium the agent
 * is driving through its tools. WHAT the picture is — video off the browser's own X display, or CDP frames of
 * one page — is live-view.ts's decision, made once for both surfaces.
 *
 * The stream is READ-ONLY BY DEFAULT, not by refusing input, but because the client sends none until the user
 * asks. That distinction matters: this is the owner's own browser inside the owner's own sandbox, so there is
 * nothing to forbid; what there is, is a default that keeps a click meant for the transcript from landing on the
 * page the agent is mid-way through filling in. When the user does take over (the view's Take control), the
 * input starts flowing and lands here unremarked.
 *
 * Closing this socket stops the picture and nothing else. The browser belongs to the turn, not to the viewer,
 * walking away from the window must not end the work being watched, which is the same contract the terminal
 * panel's attach has with tmux. */
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

        /* THE TAB STRIP, which only the frames path has and only the frames path needs. A screencast shows ONE
         * page, so choosing which is a real question; the video path shows the window, and the window already
         * has Chromium's own tab strip in it, which the owner clicks directly. `bind` is answered either way so
         * the client never has to know which it is looking at — on video it simply lands on nothing.
         *
         * A page id the session doesn't know is a tab that closed between the relist and the click: say so
         * rather than leaving the strip lying about it. */
        const onBind = async (pageId: string, ws: Socket): Promise<void> => {
            const page = browserSessionPage(session, pageId);
            if (page === undefined) {
                ws.send(JSON.stringify({ type: "gone", pageId }));
                return;
            }
            await view?.bind(page);
        };

        // Ctrl+C over the picture: hand back what the page has selected so the client can put it on the
        // clipboard of the machine the person is actually sitting at. Answered even when empty, because the
        // client is waiting on it before it lets the keystroke go.
        const onSelection = async (ws: Socket): Promise<void> => {
            ws.send(JSON.stringify({ type: "selection", text: (await view?.selection()) ?? "" }));
        };

        /* THE CONVERSATION-LEVEL HALF of this socket: keepalive, what to stream, what is selected, whether
         * anyone is looking. Split from the input half because the two answer different questions — this one is
         * about the VIEW, the other is about the BROWSER. Answers whether it handled the frame. */
        const handleControl = async (message: ScreencastClientMessage, ws: Socket): Promise<boolean> => {
            switch (message.type) {
                case "ping":
                    // The client's keepalive against tunnel idle-reaping; the pong is its read-side liveness
                    // signal, exactly as on the terminal socket (a picture of a STILL page may send nothing at
                    // all, so silence here would be indistinguishable from a half-open connection). Answered
                    // before anything is attached, or a slow Chromium start would read as a dead socket and the
                    // client would tear down the very connection it is waiting on.
                    ws.send(JSON.stringify({ type: "pong" }));
                    return true;
                case "pause":
                case "resume":
                    // Nobody is looking (hidden tab, another route). On video this kills the encoder outright,
                    // which is a core given back; on frames it holds the binding and sends nothing.
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
                    // The agent's browser may sit signed in as the owner, taking its wheel is operating,
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
                // be ahead of Chromium's first paint, browserSessionContext resolves when the attach lands.
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
                    // The key the session's display was allocated under, which is what decides video or frames.
                    // A session whose browser ended up headless has none, and the frames path answers instead.
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
