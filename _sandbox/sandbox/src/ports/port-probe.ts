import http from "node:http";
import https from "node:https";
import type { LoopbackHost } from "./port-scan.js";

// Whether anything answers on a port, and in which scheme; a plaintext check alone would misread an https-only dev
// server as down.

export type PortScheme = "http" | "https";

// Whether `scheme` answers at all; any HTTP status counts, since a watch server is up before it has routes. TLS
// verification is off for self-signed dev certs.
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

// The listener's scheme, or undefined for no listener, a booting server, or WebSocket-only; http and https probes
// refuse each other's protocol cleanly.
export const detectScheme = async (port: number, host: LoopbackHost = "127.0.0.1"): Promise<PortScheme | undefined> => {
    if (await answers("http", port, host)) {
        return "http";
    }
    return (await answers("https", port, host)) ? "https" : undefined;
};

// cachedScheme trades a slow, definitive answer for a cheap one on polled routes; a gesture always re-probes since a
// restart may change scheme. A stable answer's TTL is long, an ambiguous silence's is short (booting vs. permanently
// silent). In-flight probes are shared so concurrent callers cost one dial.
const SCHEME_TTL_MS = 30_000;
const SILENT_TTL_MS = 5_000;

interface ProbedScheme {
    readonly at: number;
    readonly scheme: PortScheme | undefined;
}
const probed = new Map<string, ProbedScheme>();
const inFlight = new Map<string, Promise<PortScheme | undefined>>();

// Keyed by ephemeral ports; expired entries are swept rather than LRU-evicted.
const MAX_PROBED = 512;

const sweepExpired = (now: number): void => {
    for (const [key, entry] of probed) {
        if (now - entry.at >= (entry.scheme === undefined ? SILENT_TTL_MS : SCHEME_TTL_MS)) {
            probed.delete(key);
        }
    }
};

export const cachedScheme = async (port: number, host: LoopbackHost = "127.0.0.1"): Promise<PortScheme | undefined> => {
    const key = `${host}:${port}`;
    const hit = probed.get(key);
    if (hit !== undefined && Date.now() - hit.at < (hit.scheme === undefined ? SILENT_TTL_MS : SCHEME_TTL_MS)) {
        return hit.scheme;
    }
    const running = inFlight.get(key);
    if (running !== undefined) {
        return running;
    }
    const probe = detectScheme(port, host)
        .then((scheme) => {
            const at = Date.now();
            if (probed.size >= MAX_PROBED) {
                sweepExpired(at);
            }
            probed.set(key, { at, scheme });
            return scheme;
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, probe);
    return probe;
};
