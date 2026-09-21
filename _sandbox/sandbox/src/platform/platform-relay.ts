import { request } from "node:https";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./tls/local-tls.js";

// One buffered platform call onto the platform's non-session routes (wallet-signer.ts, fleet/fleet-client.ts). Its
// answer is relayed through untouched, since a refusal is already written for its reader. node:https, not fetch: a dev
// platform's cert needs per-request verification skipped.

export interface RelayedAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

// WHAT A CALL PRESENTS TO PROVE WHO IS ASKING. The connect token names this SANDBOX and reaches only its own relay
// routes; a provisioning token names the owner's ACCOUNT and reaches only /fleet. Disjoint on purpose, so a leaked
// credential is bounded by the door it was minted for rather than by what the holder thinks to try.
export type PlatformAuth = { readonly kind: "connect" } | { readonly kind: "bearer"; readonly token: string };

export interface PlatformCall {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly payload?: string;
    readonly auth: PlatformAuth;
    // What a dead or absent platform did NOT do, in the caller's own words: the sentence is read by a person deciding
    // whether to retry, and "nothing was charged" and "nothing was created" settle different worries.
    readonly unreached: string;
}

const headerFor = (config: Config, auth: PlatformAuth): Record<string, string> | undefined => {
    if (auth.kind === "connect") {
        return config.connectToken === "" ? undefined : { "x-intentic-connect": config.connectToken };
    }
    return auth.token === "" ? undefined : { authorization: `Bearer ${auth.token}` };
};

export const callPlatform = (config: Config, call: PlatformCall): Promise<RelayedAnswer> =>
    new Promise((resolve) => {
        const auth = headerFor(config, call.auth);
        // The one case that can't actually be relayed: no platform, or no credential for the door being knocked on.
        if (config.platform.url === "" || auth === undefined) {
            resolve({
                status: 502,
                body: JSON.stringify({ error: "this sandbox is not connected to a platform" }),
                contentType: "application/json",
            });
            return;
        }
        const url = new URL(call.path, config.platform.url);
        const req = request(
            url,
            {
                method: call.method,
                headers: {
                    ...auth,
                    ...(call.payload !== undefined ? { "content-type": "application/json" } : {}),
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
                body: JSON.stringify({ error: `the platform could not be reached, ${call.unreached}` }),
                contentType: "application/json",
            }),
        );
        // Quick calls only, so cut a dead platform short.
        req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
        req.end(call.payload);
    });
