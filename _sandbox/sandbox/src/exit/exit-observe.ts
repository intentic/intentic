import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { errorMessage } from "@intentic/base/errors";
import type { ExitObservation } from "@intentic/sandbox-contract";
import { countryName } from "./exit-countries.js";
import { type ExitResolver, resolveThroughExit } from "./exit-dns.js";
import { socksConnect } from "./exit-socks.js";

// The load-bearing check of the feature: a country switch that reports success just because a tunnel came up has proven
// nothing. Requests go through the exit on a caller-supplied socket, built by hand rather than via fetch, since there's
// no global proxy setting and one would route the daemon's own traffic through a volunteer relay.

const PROBE_TIMEOUT_MS = 20_000;

// Probes tried in order; Cloudflare's trace endpoint first (address+country in one response, no key or limit).
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
            // `loc` XX means Cloudflare couldn't place the address: report the IP, country unknown, not a parse
            // failure.
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
        // Plain HTTP: this provider's free tier has no TLS; last in the list because of it.
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

// How a caller opens a raw TCP connection through the exit; tor hands out a SOCKS port, a tunnel hands out a source
// address.
export type ExitDialer = (host: string, port: number) => Promise<Socket>;

// One HTTP/1.1 GET over an already-connected socket, TLS layered on when needed. Hand-built since the socket is already
// inside the exit and nothing higher-level can reuse it; `Connection: close` avoids parsing chunked encoding.
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
                // A challenge or block page is common for Tor exits; the status says the destination refused, not the
                // exit.
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

// Tries every probe in turn, returns the first that answers. An exit that can't reach Cloudflare is often just
// relay-blocked, not broken; giving up there would report a working exit as failed.
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
            failures.push(`${probe.host}: ${errorMessage(error)}`);
        }
    }
    throw new Error(`could not read this exit's public address. Tried:\n${failures.map((line) => `  ${line}`).join("\n")}`);
};

// Through a SOCKS-publishing provider (tor); hostnames resolve at the exit, private and geographically honest.
export const observeThroughSocks = (proxyPort: number): Promise<ExitObservation> =>
    observeThrough((host, port) => socksConnect(proxyPort, host, port));

// Through an interface-publishing provider (vpngate, wireguard); the name resolves through the exit first
// (exit-dns.ts), then the socket binds to the tunnel address so routing picks it up.
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
