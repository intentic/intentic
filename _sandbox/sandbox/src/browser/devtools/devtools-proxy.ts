import { upgradeWebSocket } from "@hono/node-server";
import type { Context } from "hono";
import { WebSocket } from "ws";
import type { AppEnv } from "../../app-env.js";
import type { MediaTickets } from "../../auth/tokens/media-tickets.js";

// Chromium's own DevTools for one page, for the person: the frontend Chromium ships (it serves it under /devtools/ on its
// debugging port) and the page's DevTools socket, both carried through the daemon to a frame in the editor. The frame is
// the real thing, HTML drawn by the person's own browser rather than a picture of one, inspecting the page itself.
//
// A frame sends no header, so its credential is a ticket in the path (browser.devtools mints it at maintainer), and
// every relative address the frontend loads carries it. The ticket names a window and one of its pages, never a port:
// the port is read off the running window at each request, so a ticket outliving its window opens nothing.

const TICKET_PREFIX = "browser-devtools:";

// allow(route-literal): the daemon's own DevTools route, which app.ts lets the editor frame.
export const DEVTOOLS_PATH = "/browser/devtools/";

/** What a ticket is bound to: the window by name and the page by its DevTools target id, which hold no space. */
export const devtoolsBinding = (window: string, target: string): string => `${TICKET_PREFIX}${window} ${target}`;

const bindingOf = (tickets: MediaTickets, ticket: string): { readonly window: string; readonly target: string } | undefined => {
    const bound = tickets.bound(ticket);
    const [window, target, ...more] = bound?.startsWith(TICKET_PREFIX) === true ? bound.slice(TICKET_PREFIX.length).split(" ") : [];
    return window === undefined || target === undefined || more.length > 0 ? undefined : { window, target };
};

// Target ids are hex; a frontend path is one Chromium serves under /devtools/, never a way out of it.
const TARGET = /^[A-F0-9]{16,64}$/iu;
const FRONTEND_PATH = /^[A-Za-z0-9_.\-/]+$/u;

export interface DevToolsDeps {
    readonly mediaTickets: MediaTickets;
    // The window's debugging port, while it runs and has one.
    readonly portOf: (window: string) => number | undefined;
}

// The response headers a frontend file keeps; the rest are Chromium's to its own client.
const KEPT = ["content-type", "content-length", "last-modified", "etag"];

/** GET /browser/devtools/{ticket}/*: one file of the frontend, from the window's own Chromium. */
export const devtoolsFrontendRoute =
    (deps: DevToolsDeps) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const binding = bindingOf(deps.mediaTickets, c.req.param("ticket") ?? "");
        const port = binding === undefined ? undefined : deps.portOf(binding.window);
        if (binding === undefined || port === undefined) {
            return c.json({ error: "this DevTools link has expired; open DevTools again" }, 401);
        }
        const prefix = `${DEVTOOLS_PATH}${c.req.param("ticket") ?? ""}/`;
        const rest = new URL(c.req.url).pathname.slice(prefix.length);
        if (!FRONTEND_PATH.test(rest) || rest.split("/").includes("..")) {
            return c.json({ error: "not found" }, 404);
        }
        // allow(silent-catch): a browser that does not answer is the 502 below, the frame's own word for it.
        const upstream = await fetch(`http://127.0.0.1:${String(port)}/devtools/${rest}`).catch(() => undefined);
        if (upstream === undefined) {
            return c.json({ error: "the browser is not answering" }, 502);
        }
        const headers = new Headers();
        for (const name of KEPT) {
            const value = upstream.headers.get(name);
            if (value !== null) {
                headers.set(name, value);
            }
        }
        // Built for one Chromium, and the URL carries the ticket: kept by this browser alone, for the frame's life.
        headers.set("cache-control", "private, max-age=3600");
        return new Response(upstream.body, { status: upstream.status, headers });
    };

/** GET /browser/devtools/{ticket}/ws/page/{target}: the page's DevTools socket, carried both ways. */
export const devtoolsSocketRoute = (deps: DevToolsDeps) =>
    upgradeWebSocket((c) => {
        const binding = bindingOf(deps.mediaTickets, c.req.param("ticket") ?? "");
        const target = c.req.param("target") ?? "";
        const port = binding === undefined ? undefined : deps.portOf(binding.window);
        const allowed = binding !== undefined && port !== undefined && c.req.param("kind") === "page" && TARGET.test(target) && binding.target === target;
        let upstream: WebSocket | undefined;
        // What the frontend sent before Chromium answered: CDP is ordered, so it waits rather than being dropped.
        const queued: string[] = [];
        return {
            onOpen: (_event, ws) => {
                if (!allowed) {
                    ws.close(1008, "unauthorized");
                    return;
                }
                const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/devtools/page/${target}`, { perMessageDeflate: false });
                upstream = socket;
                socket.on("open", () => {
                    for (const message of queued.splice(0)) {
                        socket.send(message);
                    }
                });
                socket.on("message", (data) => ws.send(String(data)));
                socket.on("close", () => ws.close(1000, "the page's DevTools closed"));
                socket.on("error", () => ws.close(1011, "the browser is not answering"));
            },
            onMessage: (event) => {
                const message = String(event.data);
                if (upstream?.readyState === WebSocket.OPEN) {
                    upstream.send(message);
                } else {
                    queued.push(message);
                }
            },
            onClose: () => upstream?.close(),
            onError: () => upstream?.close(),
        };
    });
