import { request } from "node:https";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./tls/local-tls.js";

/* ONE BUFFERED PLATFORM CALL, authenticated by the connect token, the daemon's door onto the platform's
 * connect-token routes (the wallet's signer above all, wallet/wallet-signer.ts).
 *
 * The daemon adds exactly one thing here: the connect token, which is the credential that names whose
 * account is acting and which the platform refuses everything without. Everything else is the platform's
 * job, and the relay carries its answers through untouched, because a refusal is ALREADY written for the
 * person who will read it, and a daemon that rewrote it would only blur who said what.
 *
 * node:https for the platform-client.ts reason: a dev platform is a self-signed cert on
 * host.docker.internal, and undici cannot skip verification for one request only. */

export interface RelayedAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

// The daemon's own sentence for a sandbox with no platform, the one answer that can't be relayed.
const UNRELAYABLE: RelayedAnswer = {
    status: 502,
    body: JSON.stringify({ error: "this sandbox is not connected to a platform" }),
    contentType: "application/json",
};

export const relayPlatform = (config: Config, method: "GET" | "POST", path: string, payload?: string): Promise<RelayedAnswer> =>
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
                rejectUnauthorized: !isLocalHost(url.hostname),
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                response.on("end", () => {
                    resolve({
                        status: response.statusCode ?? 502,
                        body: raw,
                        contentType: response.headers["content-type"] ?? "application/json",
                    });
                });
            },
        );
        req.on("error", () =>
            resolve({
                status: 502,
                body: JSON.stringify({ error: "the platform could not be reached, nothing was charged" }),
                contentType: "application/json",
            }),
        );
        // Quick calls only, so cut a dead platform short.
        req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
        req.end(payload);
    });
