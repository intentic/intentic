import { request } from "node:https";
import type { Config } from "../env.config.js";

/* THE SERVICES RELAY — the daemon's door onto the platform's metered service runs, relayed VERBATIM.
 *
 * The daemon adds exactly one thing here: the connect token, which is the credential that names whose
 * membership pays and which the platform refuses everything without. Everything else — the member gate, the
 * credit meter, the spend-then-refund, the signed forward to the provider — is the platform's job, and the
 * relay carries its answers through untouched (status, body, content type), because a refusal like
 * `insufficient_credits` is ALREADY written for the person who will read it, and a daemon that rewrote it
 * would only blur who said what.
 *
 * This is the route surface an extension backend declares in `permissions.daemon` — a glob like
 * "POST /pool/services/<one segment>/run" — so which services an extension may spend the owner's credits on
 * is in its manifest, diffable, and approved at install like every other reach it has.
 *
 * node:https for the platform-client.ts reason: a dev platform is a self-signed cert on
 * host.docker.internal, and undici cannot skip verification for one request only. */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal"]);

export interface RelayedAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
    // The platform's advisory credits header on a served run (x-intentic-credits-remaining) — what the CLI's
    // receipt line and the offer card's receipt render. Absent when the platform sent none (a refusal, the
    // catalog). Its presence is also the one honest "this run was CHARGED" signal: the platform sets it
    // exactly when a forward served, so the receipt reads it rather than re-deriving spend from status codes.
    readonly remaining?: string;
}

// The daemon's own sentence for a sandbox with no platform — the one answer that can't be relayed.
const UNRELAYABLE: RelayedAnswer = {
    status: 502,
    body: JSON.stringify({ error: "this sandbox is not connected to a platform, and premium services need one" }),
    contentType: "application/json",
};

const relay = (config: Config, method: "GET" | "POST", path: string, payload?: string): Promise<RelayedAnswer> =>
    new Promise((resolve) => {
        if (config.platform.url === "" || config.connectToken === "") {
            resolve(UNRELAYABLE);
            return;
        }
        const url = new URL(path, config.platform.url);
        const req = request(
            url,
            {
                method,
                headers: {
                    "x-intentic-connect": config.connectToken,
                    ...(payload !== undefined ? { "content-type": "application/json" } : {}),
                },
                rejectUnauthorized: !LOCAL_HOSTS.has(url.hostname),
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                response.on("end", () => {
                    const remaining = response.headers["x-intentic-credits-remaining"];
                    resolve({
                        status: response.statusCode ?? 502,
                        body: raw,
                        contentType: response.headers["content-type"] ?? "application/json",
                        ...(typeof remaining === "string" ? { remaining } : {}),
                    });
                });
            },
        );
        req.on("error", () =>
            resolve({
                status: 502,
                body: JSON.stringify({ error: "the platform could not be reached — nothing was charged" }),
                contentType: "application/json",
            }),
        );
        // A run's whole budget upstream is the platform's 60s forward; give the relay a little more so the
        // platform's own timeout answer (a refunded 502) wins over a blunter local one.
        req.setTimeout(75_000, () => req.destroy(new Error("timeout")));
        req.end(payload);
    });

// The catalog + the owner's meter, as the platform states them.
export const relayServiceCatalog = (config: Config): Promise<RelayedAnswer> => relay(config, "GET", "/pool/services");

// One metered run. The slug rides the path; the body is the service's own JSON, untouched.
export const relayServiceRun = (config: Config, slug: string, body: string): Promise<RelayedAnswer> =>
    relay(config, "POST", `/pool/services/${encodeURIComponent(slug)}/run`, body);
