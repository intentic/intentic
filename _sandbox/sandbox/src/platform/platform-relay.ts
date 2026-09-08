import { request } from "node:https";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./tls/local-tls.js";

// One buffered platform call, authenticated by the connect token, onto the platform's connect-token routes
// (wallet-signer.ts above all). Its answer is relayed through untouched, since a refusal is already written for its
// reader. node:https, not fetch: a dev platform's cert needs per-request verification skipped.

export interface RelayedAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

// The daemon's own answer for a sandbox with no platform; the one case that can't actually be relayed.
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
