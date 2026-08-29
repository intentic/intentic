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

/* THE SAME PROBE FOR THE ROUTES THAT ARE POLLED, which is a different problem from the one above.
 *
 * `detectScheme` costs up to two dials of 1500ms each, so a port nothing answers on costs THREE SECONDS. That is
 * the honest price of the question when somebody asks it once. It is the wrong price to pay per listener, per
 * repo, on every read of a route the browser refetches every few seconds: measured on this workspace, GET
 * /panels is the browser's most-fetched query (5,539 reads in one 11-hour session) and GET /workspace/tree the
 * second-slowest endpoint the daemon serves, and both of them are almost entirely this probe.
 *
 * SO THE POLLED READS ASK THIS ONE and the gestures keep asking the bare probe. That split is deliberate and it
 * is why the cache does not simply live inside `detectScheme`: `port-forwards.ts` re-probes ON PURPOSE when the
 * owner forwards a port, because a dev server restarted on the same port may have flipped scheme, and a cached
 * answer there would forward the click to the wrong protocol. A poll wants the cheap answer; a gesture wants the
 * true one.
 *
 * TWO TTLs, because the two outcomes have opposite economics, and knowing WHICH probe is the slow one is what
 * sets them. A port with nothing on it refuses the TCP connect immediately, so a dead port was never the
 * expensive case. The three seconds is a port that ACCEPTS and then does not speak HTTP: a WebSocket-only
 * sidecar (Vite's HMR channel is one, on every dev server in this workspace), or a server still coming up.
 *   - AN ANSWER IS STABLE. Flipping http↔https takes a server restart, which drops the listener and usually
 *     moves the port, so a positive is good for as long as anything here is worth caching.
 *   - SILENCE IS THE EXPENSIVE ONE AND THE AMBIGUOUS ONE: the permanent kind (that HMR channel, re-probed at
 *     3s per poll forever) is indistinguishable from the temporary kind (a dev server mid-boot), so the TTL is
 *     a straight trade between the two. It is short, because the temporary kind is what a person is WATCHING:
 *     the panel's "Starting…" screen clears when this answers, and making a Start feel slower to save the
 *     daemon some dials is the wrong way round. Five seconds sits under the time a dev server takes to boot
 *     anyway, so it rarely adds a visible step, while still collapsing the burst a single render fires.
 *
 * IN-FLIGHT PROBES ARE SHARED, which matters more than either TTL: one page render asks about the same port from
 * several components, and two browser tabs ask at the same moment. Without this they each open their own socket
 * and each wait out their own timeout, so the 3s worst case was being paid several times over in parallel. */
const SCHEME_TTL_MS = 30_000;
const SILENT_TTL_MS = 5_000;

interface ProbedScheme {
    readonly at: number;
    readonly scheme: PortScheme | undefined;
}
const probed = new Map<string, ProbedScheme>();
const inFlight = new Map<string, Promise<PortScheme | undefined>>();

/* Dev servers take EPHEMERAL ports, a fresh one per restart, so the key space here is "every port anything in
 * this sandbox has ever bound" rather than the handful live at any moment, and a daemon runs for days. Swept
 * rather than LRU-evicted because every entry expires on its own schedule anyway: past the cap, drop what is
 * already dead, which on a real workspace empties almost the whole map and costs one pass over a few hundred
 * entries at most. The cap only has to be far above the live set to make this rare. */
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
