import { upgradeWebSocket } from "@hono/node-server";
import { browserSessionContext } from "./browser-sessions.js";
import { dispatchInput, startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type Screencast, type ScreencastClientMessage } from "./screencast.js";
import type { Services } from "../composition.js";

/* The /system/browser-view route: WATCH THE AGENT BROWSE, and take the wheel if you want to.
 *
 * Same wire as /system/browser-login (a header-less WebSocket authorizing token+connect from the query string;
 * app.ts exempts it from the bearer middleware) and the same frames, because it is the same thing pointed at a
 * different browser: there, the daemon's own Chromium waiting for the owner to sign in; here, the Chromium the
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

        const cleanup = async (): Promise<void> => {
            if (closed) {
                return;
            }
            closed = true;
            await screencast?.stop();
            screencast = undefined;
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                if (services.auth !== undefined) {
                    try {
                        await services.auth.authorize(url.searchParams.get("token") ?? "", url.searchParams.get("connect") ?? undefined);
                    } catch (err) {
                        services.logger.warn({ err }, "browser-view authorize failed");
                        ws.close(1008, "unauthorized");
                        return;
                    }
                }
                const session = url.searchParams.get("session") ?? "";
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
                    screencast = await startScreencast(context, (data) => ws.send(JSON.stringify({ type: "frame", data })));
                    ws.send(JSON.stringify({ type: "ready", width: VIEW_WIDTH, height: VIEW_HEIGHT }));
                } catch (err) {
                    services.logger.warn({ err }, "browser-view screencast failed");
                    ws.send(JSON.stringify({ type: "error", message: "Couldn't attach to that browser." }));
                    await cleanup();
                    ws.close(1011, "screencast failed");
                }
            },
            onMessage: async (event, ws) => {
                const attached = screencast?.attached();
                if (attached === undefined || closed) {
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
                    ws.send(JSON.stringify({ type: "pong" }));
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
