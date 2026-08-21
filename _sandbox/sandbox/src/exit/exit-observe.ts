import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ExitObservation } from "@intentic/sandbox-contract";
import { countryName } from "./exit-countries.js";
import { type ExitResolver, resolveThroughExit } from "./exit-dns.js";
import { socksConnect } from "./exit-socks.js";

/* WHAT THE WORLD SEES. The load-bearing check of the whole feature: a country switch that reports success
 * because a tunnel came up has reported nothing, and this is what turns it into a claim worth making.
 *
 * The request has to go THROUGH the exit, which is why it is built by hand on a socket the caller supplies
 * rather than with fetch: there is no global proxy setting to reach for, and setting one would put the
 * daemon's own traffic through a volunteer relay, which is exactly what this design refuses to do.
 */

const PROBE_TIMEOUT_MS = 20_000;

// Where to ask, in order. Cloudflare's trace endpoint first and by some distance: it answers at the edge
// before any bot challenge, returns the address AND the country in one cheap plaintext response, needs no key
// and has no rate limit worth thinking about. The others are fallbacks for when a destination blocks
// Cloudflare or the exit's own operator intercepts it.
const PROBES: readonly { host: string; path: string; tls: boolean; parse: (body: string) => ExitObservation | undefined }[] = [
    {
        host: "www.cloudflare.com",
        path: "/cdn-cgi/trace",
        tls: true,
        parse: (body) => {
            const fields = new Map(
                body
                    .split("\n")
                    .map((line) => line.split("="))
                    .flatMap(([key, value]) => (key === undefined || value === undefined ? [] : [[key.trim(), value.trim()] as const])),
            );
            const ip = fields.get("ip");
            const loc = fields.get("loc");
            // `loc` is XX for an address Cloudflare cannot place, which is an answer about the address, not a
            // parse failure: report the IP and leave the country unknown rather than discard the reading.
            return ip === undefined ? undefined : observation(ip, loc === undefined || loc === "XX" ? undefined : loc);
        },
    },
    {
        host: "ifconfig.co",
        path: "/json",
        tls: true,
        parse: (body) => {
            const parsed = JSON.parse(body) as { ip?: unknown; country_iso?: unknown };
            return typeof parsed.ip === "string"
                ? observation(parsed.ip, typeof parsed.country_iso === "string" ? parsed.country_iso : undefined)
                : undefined;
        },
    },
    {
        // Plain HTTP: this one's free tier does not serve TLS. Last in the list for that reason, and harmless
        // where it lands, the answer is a public fact about the connection making the request.
        host: "ip-api.com",
        path: "/json/?fields=query,countryCode",
        tls: false,
        parse: (body) => {
            const parsed = JSON.parse(body) as { query?: unknown; countryCode?: unknown };
            return typeof parsed.query === "string"
                ? observation(parsed.query, typeof parsed.countryCode === "string" ? parsed.countryCode : undefined)
                : undefined;
        },
    },
];

const observation = (ip: string, country: string | undefined): ExitObservation => ({
    ip,
    ...(country === undefined ? {} : { country: country.toUpperCase(), countryName: countryName(country) }),
});

// How a caller opens a raw TCP connection that comes out of the exit. Two shapes exist because the two kinds
// of provider are genuinely different: tor hands out a SOCKS port, a tunnel hands out a source address.
export type ExitDialer = (host: string, port: number) => Promise<Socket>;

// One HTTP/1.1 GET over an already-connected socket, with TLS put on top when the probe wants it. Hand-built
// because the socket is the whole point: it is already inside the exit and nothing higher-level can be told
// to use it. `Connection: close` makes the body's end unambiguous without parsing chunked encoding.
const get = (socket: Socket, host: string, path: string, useTls: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
        const stream = useTls ? tlsConnect({ socket, servername: host }) : socket;
        let body = "";
        const timer = setTimeout(() => {
            stream.destroy();
            reject(new Error(`${host} did not answer through the exit within ${PROBE_TIMEOUT_MS / 1000}s`));
        }, PROBE_TIMEOUT_MS);
        const done = (error?: Error): void => {
            clearTimeout(timer);
            stream.destroy();
            if (error !== undefined) {
                reject(error);
                return;
            }
            const split = body.indexOf("\r\n\r\n");
            if (split < 0) {
                reject(new Error(`${host} sent no complete response through the exit`));
                return;
            }
            const status = Number.parseInt(body.slice(9, 12), 10);
            if (!Number.isInteger(status) || status >= 400) {
                // A challenge page or a block, which is a real and common outcome for Tor exits: naming the
                // status is what tells a reader "the destination refused you", not "the exit is broken".
                reject(new Error(`${host} answered ${Number.isInteger(status) ? status : "an unreadable status"} through the exit`));
                return;
            }
            resolve(body.slice(split + 4));
        };
        stream.on("error", (error: Error) => done(error));
        stream.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
        });
        stream.on("close", () => done());
        const request = [`GET ${path} HTTP/1.1`, `Host: ${host}`, "User-Agent: curl/8.5.0", "Accept: */*", "Connection: close", "", ""].join("\r\n");
        if (useTls) {
            stream.once("secureConnect", () => stream.write(request));
        } else {
            stream.write(request);
        }
    });

/* Ask every probe in turn and take the first that answers. Failing over matters more here than it looks: an
 * exit that cannot reach Cloudflare is usually not a broken exit, it is a relay whose address Cloudflare has
 * decided to challenge, and giving up there would report a perfectly working German exit as failed. */
export const observeThrough = async (dial: ExitDialer): Promise<ExitObservation> => {
    const failures: string[] = [];
    for (const probe of PROBES) {
        try {
            const socket = await dial(probe.host, probe.tls ? 443 : 80);
            const seen = probe.parse(await get(socket, probe.host, probe.path, probe.tls));
            if (seen !== undefined) {
                return seen;
            }
            failures.push(`${probe.host}: answered with no address`);
        } catch (error) {
            failures.push(`${probe.host}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`could not read this exit's public address. Tried:\n${failures.map((line) => `  ${line}`).join("\n")}`);
};

// Through a provider that publishes a SOCKS port (tor). Hostnames are handed to the proxy as names, so they
// resolve at the exit, which is both the private answer and the geographically honest one.
export const observeThroughSocks = (proxyPort: number): Promise<ExitObservation> =>
    observeThrough((host, port) => socksConnect(proxyPort, host, port));

// Through a provider that publishes an interface (vpngate, wireguard). The name is resolved through the exit
// first (exit-dns.ts), then the socket is bound to the tunnel address so the routing rule picks it up.
export const observeThroughAddress = (localAddress: string, resolver: ExitResolver): Promise<ExitObservation> =>
    observeThrough(async (host, port) => {
        const address = await resolveThroughExit(resolver, host);
        return await new Promise<Socket>((resolve, reject) => {
            const socket = netConnect({ host: address, port, localAddress });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`${host} did not accept a connection from the exit within ${PROBE_TIMEOUT_MS / 1000}s`));
            }, PROBE_TIMEOUT_MS);
            socket.once("connect", () => {
                clearTimeout(timer);
                resolve(socket);
            });
            socket.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
    });
