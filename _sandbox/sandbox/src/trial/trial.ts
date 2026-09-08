import { request } from "node:https";
import { type TrialHealth, TrialStatusSchema } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import { isLocalHost } from "../platform/tls/local-tls.js";

// Trial is served by the platform, not this daemon, and its existence is the platform operator's decision; a sandbox
// must probe rather than assume it. Availability is probed at boot and on the allowance poll, then cached; unknown
// reads as absent.

export interface TrialStatus {
    readonly allowance: number;
    readonly used: number;
    readonly remaining: number;
    readonly health: TrialHealth;
    // ISO stamp of the next UTC midnight, the browser renders it in local time.
    readonly resetsAt: string;
    readonly retryAt?: string;
    // Real model behind the trial's published id for the account's latest message; the platform routes a ladder.
    readonly servedModel?: string;
}

export interface TrialService {
    // Whether a trial endpoint should exist; false until a probe says otherwise.
    readonly available: () => boolean;
    // The last status read, or undefined before the first successful one.
    readonly status: () => TrialStatus | undefined;
    // Re-probes; swallows its own failure, since an unreachable platform is not something the caller can act on.
    readonly refresh: () => Promise<void>;
}

// Authenticated GET via the connect token, over node:https rather than undici, since a dev platform's self-signed cert
// on host.docker.internal needs per-request verification skip undici can't do.
const getJson = (config: Config, path: string): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve, reject) => {
        const url = new URL(path, config.platform.url);
        const req = request(
            url,
            {
                method: "GET",
                headers: { "x-intentic-connect": config.connectToken },
                rejectUnauthorized: !isLocalHost(url.hostname),
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                response.on("end", () => {
                    let json: unknown;
                    try {
                        json = JSON.parse(raw);
                    } catch {
                        json = undefined;
                    }
                    resolve({ status: response.statusCode ?? 0, json });
                });
            },
        );
        req.on("error", reject);
        req.setTimeout(15_000, () => req.destroy(new Error("the platform did not respond in time")));
        req.end();
    });

const isStatus = (value: unknown): value is TrialStatus => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const parsed = TrialStatusSchema.safeParse({ ...value, available: true });
    return parsed.success && typeof parsed.data.resetsAt === "string";
};

export const createTrialService = (config: Config, get = getJson): TrialService => {
    let status: TrialStatus | undefined;
    let available = false;
    // No platform means nobody to ask and no account to meter; same gate announcing uses.
    const configured = config.platform.url !== "" && config.connectToken !== "";
    return {
        available: () => available,
        status: () => status,
        refresh: async () => {
            if (!configured) {
                return;
            }
            const response = await get(config, "/trial/status").catch(() => undefined);
            if (response === undefined) {
                // Left as-is, not cleared: a blip hasn't withdrawn the trial, and dropping it would strand an
                // in-progress turn.
                return;
            }
            // 404 means no trial, whether the platform serves none or doesn't know this sandbox; both are final.
            if (response.status === 404) {
                available = false;
                status = undefined;
                return;
            }
            if (response.status === 200 && isStatus(response.json)) {
                available = true;
                status = response.json;
            }
        },
    };
};
