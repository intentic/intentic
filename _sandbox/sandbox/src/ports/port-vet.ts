import type { Config } from "../env.config.js";
import { isDevToolsPort } from "./port-identity.js";
import type { ListeningPort } from "./port-scan.js";

/* Whether a port may be given an address on the outside, read off a fresh scan: the same reasons for this sandbox's own
   forward (ports.routes.ts) and for a runner's port the parent asks this runner about (runners/live, 2026-11-23). */

// The daemon's own listeners, never listed or forwarded: netd's daemon port, its preview port and its loopback listener
// (bootstrap/netd-door.ts listenConfigOf), and sshd. The loopback one binds every interface in a container and answers the
// daemon's whole API, which on a runner (no auth) a preview of it would hand to anyone with the address (2026-11-23).
export const daemonListenerPorts = (config: { readonly [K in "sandbox" | "preview" | "local"]: Pick<Config[K], "port"> }): ReadonlySet<number> =>
    new Set([config.sandbox.port, config.preview.port, config.local.port, 22]);

// The reason the port may not be forwarded, or undefined when it may. `reserved`: the daemon's own listeners.
export const portRefusal = (port: number, listeners: readonly ListeningPort[], reserved: ReadonlySet<number>): string | undefined => {
    if (reserved.has(port)) {
        return `port ${port} belongs to the sandbox itself and can't be forwarded`;
    }
    const listener = listeners.find((candidate) => candidate.port === port);
    if (listener === undefined) {
        return `nothing is listening on port ${port}`;
    }
    // Refused outright, not left to the person's judgement: the row reads "Agent browser", which says nothing about the
    // forward handing every cookie of a signed-in account to whoever has the URL.
    if (isDevToolsPort(listener)) {
        return `port ${port} is a browser's DevTools port: it drives that browser and its signed-in sessions, so it is never forwarded`;
    }
    if (!listener.forwardable) {
        return `port ${port} is bound to a loopback address the preview proxy can't reach`;
    }
    return undefined;
};
