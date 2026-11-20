import { lookup } from "node:dns/promises";
import { Agent, request as httpRequest } from "node:http";
import { connect as http2Connect } from "node:http2";
import { connect as netConnect } from "node:net";
import { performance } from "node:perf_hooks";
import { BROWSER_VIEW_PATH } from "@intentic/sandbox-contract/browser-wire";
import { VITALS_PATH } from "@intentic/sandbox-contract/protocol/vitals";
import { WebSocket } from "ws";
import { round1, type Summary, summarize } from "./stats.js";

// The hairpin: what reaching this sandbox through its public address costs over reaching it on loopback. The editor on
// the owner's own computer opens the sandbox through the edge unless the loopback shortcut is allowed and answering
// (_editor/web/src/client/endpoint/useEndpoint.ts), and always for any sandbox but the active one (sandboxTarget.ts's
// targetFor), so every frame and every keystroke of a browser view rides out to the edge and back in.
//
// A browser view socket needs a ticket minted for a signed-in member (POST /system/ws-ticket), which nothing inside the
// sandbox holds, so the picture itself cannot be streamed through the edge from here. What is measured instead, on both
// paths: netd's vitals (answered by netd itself, never Node, so it is the transport alone), over one kept-alive
// connection, request after request; the upgrade of the browser view socket, refused for want of a ticket, which is a
// round trip through Node; and the bare TCP connect to the edge's address, the network's own round trip to it.
//
// Given the edge's own door (the host netd's tunnel dials), the hairpin splits in two: the door's `/health`, which the
// edge answers itself, is the way from a browser to the edge and back (whatever stands in front of it included), and
// what the sandbox's vitals take beyond that is the tunnel's own trip down to netd and back. 2026-11-20 on this
// sandbox: vitals through the edge 38.3 ms at p50, the door alone 20.1 ms, so 17-18 ms was the tunnel, which dials the
// door through the same Cloudflare front the browser comes in by although the edge runs on this very machine.

export interface EdgeReport {
    readonly measuredAt: string;
    readonly samples: number;
    // GET /system/vitals, one kept-alive HTTP/1.1 connection on loopback; HTTP/2 through the edge, as a browser speaks it.
    readonly loopbackHttpMs: Summary;
    readonly edgeHttpMs: Summary;
    // The browser view socket's upgrade until the daemon's answer (a refusal: there is no ticket), on each path.
    readonly loopbackUpgradeMs: Summary;
    readonly edgeUpgradeMs: Summary;
    readonly upgradeAnswer: string;
    // TCP connect to the edge's address on 443: the network round trip to the edge's front door.
    readonly edgeConnectMs: Summary;
    // GET /health on the edge's own door, answered by the edge with no tunnel in it, one kept-alive HTTP/2 connection;
    // and the share of the hairpin that is the tunnel's (edge vitals less the door, at p50 and p99). Null without a door.
    readonly doorHttpMs: Summary | null;
    readonly tunnelMs: { readonly p50: number | null; readonly p99: number | null } | null;
    // What the edge adds per request over loopback, at p50 and p99: the hairpin a frame and a keystroke each pay.
    readonly hairpinMs: { readonly p50: number | null; readonly p99: number | null };
    // netd's vitals as the edge carried them: its tunnel's state among them, kept as netd wrote it.
    readonly vitals: string;
}

const elapsed = async (work: () => Promise<void>): Promise<number> => {
    const started = performance.now();
    await work();
    return performance.now() - started;
};

const repeat = async (count: number, work: () => Promise<void>): Promise<number[]> => {
    const times: number[] = [];
    for (let index = 0; index < count; index++) {
        times.push(await elapsed(work));
    }
    return times;
};

const loopbackGet = (agent: Agent, base: string, path: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const req = httpRequest(new URL(path, base), { agent }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
                body += chunk;
            });
            response.on("end", () => resolve(body));
        });
        req.on("error", reject);
        req.end();
    });

// The status (or `open`) a WebSocket upgrade is answered with, and how long it took.
const upgrade = (url: string): Promise<string> =>
    new Promise((resolve) => {
        const ws = new WebSocket(url, { perMessageDeflate: false });
        ws.on("open", () => {
            ws.terminate();
            resolve("101 open");
        });
        ws.on("unexpected-response", (_request, response) => {
            ws.terminate();
            resolve(`${response.statusCode ?? "?"}`);
        });
        ws.on("error", () => resolve("error"));
    });

// The keep-alive HTTP/2 round trip of GET `path` on `origin`, `samples` times after one that opens the connection.
const http2Times = async (origin: string, path: string, samples: number): Promise<{ readonly times: number[]; readonly first: string }> => {
    const session = http2Connect(origin);
    const get = (): Promise<string> =>
        new Promise((resolve, reject) => {
            const stream = session.request({ ":path": path, "cache-control": "no-store" });
            let body = "";
            stream.setEncoding("utf8");
            stream.on("data", (chunk: string) => {
                body += chunk;
            });
            stream.on("end", () => resolve(body));
            stream.on("error", reject);
            stream.end();
        });
    try {
        // The first request pays DNS, TCP and TLS; the rest are what a connection that is already open pays.
        const first = await get();
        const times = await repeat(samples, async () => {
            await get();
        });
        return { times, first };
    } finally {
        session.close();
    }
};

// The edge's own door for this sandbox: the origin netd's tunnel dials (wss://<door>/tunnel/v2 in its remembered
// config, root's alone), or undefined where it cannot be read.
export const tunnelDoor = (config: string): string | undefined => {
    try {
        // SAFETY: netd writes this file in its own shape (netd-wire's TunnelConfig under `tunnel`), and a `url` that is
        // anything but a URL throws in `new URL`, which is caught below.
        const url = (JSON.parse(config) as { tunnel?: { url?: string } }).tunnel?.url;
        return url === undefined ? undefined : new URL(url).origin.replace(/^ws/u, "http");
    } catch {
        // allow(silent-catch): a config that is not netd's names no door, and the report says so with a null.
        return undefined;
    }
};

export const measureEdge = async (options: {
    readonly edge: string;
    readonly loopback: string;
    readonly samples: number;
    readonly door?: string | undefined;
    readonly log: (line: string) => void;
}): Promise<EdgeReport> => {
    const { samples, log } = options;
    const edge = new URL(options.edge);

    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const vitalsOnLoopback = async (): Promise<void> => {
        await loopbackGet(agent, options.loopback, VITALS_PATH);
    };
    await vitalsOnLoopback();
    const loopbackHttp = await repeat(samples, vitalsOnLoopback);
    agent.destroy();
    log(`loopback vitals: ${JSON.stringify(summarize(loopbackHttp))}`);

    const { times: edgeHttp, first: vitals } = await http2Times(edge.origin, VITALS_PATH, samples);
    log(`edge vitals: ${JSON.stringify(summarize(edgeHttp))}`);
    const doorHttp = options.door === undefined ? undefined : (await http2Times(options.door, "/health", samples)).times;
    if (doorHttp !== undefined) {
        log(`edge door ${options.door} /health: ${JSON.stringify(summarize(doorHttp))}`);
    }

    const upgrades = Math.min(samples, 30);
    const viewPath = `${BROWSER_VIEW_PATH}?session=castbench`;
    let answer = "";
    const loopbackUpgrade = await repeat(upgrades, async () => {
        answer = await upgrade(`${options.loopback.replace(/^http/u, "ws")}${viewPath}`);
    });
    const edgeUpgrade = await repeat(upgrades, async () => {
        answer = await upgrade(`${edge.origin.replace(/^http/u, "ws")}${viewPath}`);
    });
    log(`browser view upgrade (answered ${answer}): loopback ${JSON.stringify(summarize(loopbackUpgrade))}, edge ${JSON.stringify(summarize(edgeUpgrade))}`);

    const { address } = await lookup(edge.hostname);
    // A refused or reset connect is counted and left out, not the end of the report: the front door is shared and
    // answers a burst of bare connects as it likes.
    let refused = 0;
    const connects: number[] = [];
    for (let index = 0; index < Math.min(samples, 30); index++) {
        try {
            connects.push(
                await elapsed(
                    () =>
                        new Promise<void>((resolve, reject) => {
                            const socket = netConnect({ host: address, port: 443 }, () => {
                                socket.destroy();
                                resolve();
                            });
                            socket.on("error", reject);
                        }),
                ),
            );
        } catch {
            refused += 1;
        }
    }
    if (refused > 0) {
        log(`TCP connect to the edge: ${refused} refused`);
    }
    log(`TCP connect to the edge: ${JSON.stringify(summarize(connects))}`);

    const loopbackSummary = summarize(loopbackHttp);
    const edgeSummary = summarize(edgeHttp);
    const doorSummary = doorHttp === undefined ? null : summarize(doorHttp);
    const minus = (left: number | null, right: number | null): number | null => (left === null || right === null ? null : round1(left - right));
    return {
        measuredAt: new Date().toISOString(),
        samples,
        loopbackHttpMs: loopbackSummary,
        edgeHttpMs: edgeSummary,
        loopbackUpgradeMs: summarize(loopbackUpgrade),
        edgeUpgradeMs: summarize(edgeUpgrade),
        upgradeAnswer: answer,
        edgeConnectMs: summarize(connects),
        doorHttpMs: doorSummary,
        tunnelMs: doorSummary === null ? null : { p50: minus(edgeSummary.p50, doorSummary.p50), p99: minus(edgeSummary.p99, doorSummary.p99) },
        hairpinMs: { p50: minus(edgeSummary.p50, loopbackSummary.p50), p99: minus(edgeSummary.p99, loopbackSummary.p99) },
        vitals,
    };
};
