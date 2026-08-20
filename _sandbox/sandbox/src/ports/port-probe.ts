import http from "node:http";
import https from "node:https";
import type { LoopbackHost } from "./port-scan.js";

// Is anything answering on this port, and in which language? One primitive, because everything that asks about a
// dev server in this sandbox asks the same two things and used to get different answers: the preview proxy
// detected the scheme properly while the panel health check spoke plaintext HTTP through `fetch` with default TLS
// verification, so a Vite dev server on its own https port (a repo's own dev cert, locally signed) read as DOWN
// and a repo's panel span "Starting…" for as long as it ran.

export type PortScheme = "http" | "https";

// Whether `scheme` answers on the port at all. ANY HTTP status counts, 404 included: a watch server is up before
// it has routes, and "is this thing serving" is the only question here. Dev certs are self-signed, so TLS
// verification is off, the dial never leaves the sandbox's own netns.
export const answers = (scheme: PortScheme, port: number, host: LoopbackHost = "127.0.0.1"): Promise<boolean> =>
    new Promise((resolve) => {
        const request = (scheme === "https" ? https : http).request(
            { host, port, method: "GET", path: "/", timeout: 1500, rejectUnauthorized: false },
            (response) => {
                response.resume();
                resolve(true);
            },
        );
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve(false));
        request.end();
    });

// What the listener speaks, or undefined when nothing answered, a port with no listener, a server still
// booting, or one that only talks WebSocket. A TLS upstream rejects a plaintext request at the socket and vice
// versa, so the two probes discriminate cleanly. Callers read the undefined for themselves: the preview proxy
// forwards anyway (and 502s until the server responds), a panel's health does not.
export const detectScheme = async (port: number, host: LoopbackHost = "127.0.0.1"): Promise<PortScheme | undefined> => {
    if (await answers("http", port, host)) {
        return "http";
    }
    return (await answers("https", port, host)) ? "https" : undefined;
};
