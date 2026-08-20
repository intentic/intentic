import { request } from "node:https";
import { type TrialHealth, TrialStatusSchema } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import { isLocalHost } from "../platform/local-tls.js";

/* THE FREE TRIAL, AS THE DAEMON SEES IT, is there one, and how much of today's allowance is left.
 *
 * The trial is served BY the platform (its /trial routes), which is the one thing on this product's command
 * path that is: everything else the browser drives goes straight to this daemon. That asymmetry is why the
 * daemon has to ask rather than assume. Whether a trial exists at all is the platform operator's decision (it
 * is off unless they configured keys), and a sandbox that provisioned a trial endpoint against a platform that
 * serves none would put a dead provider in the picker and a 404 at the end of the user's first message.
 *
 * So availability is PROBED, once at boot and then on the same poll that refreshes the allowance, and cached.
 * Unknown is treated as absent: a daemon that has not heard back offers no trial, which is the failure that
 * costs a user nothing. */

export interface TrialStatus {
    readonly allowance: number;
    readonly used: number;
    readonly remaining: number;
    readonly health: TrialHealth;
    // ISO stamp of the next UTC midnight, the browser renders it in local time.
    readonly resetsAt: string;
    readonly retryAt?: string;
    // The real model behind the trial's one published id, on this account's most recent message. The platform
    // routes across a ladder, so this is the only thing that can say what actually answered.
    readonly servedModel?: string;
}

export interface TrialService {
    // Whether a trial endpoint should exist in this sandbox. False until a probe has said otherwise.
    readonly available: () => boolean;
    // The last status read, or undefined before the first successful one.
    readonly status: () => TrialStatus | undefined;
    // Re-probe. Swallows its own failure, an unreachable platform is not an error the caller can act on, and
    // the cached answer stays until one arrives.
    readonly refresh: () => Promise<void>;
}

// A single authenticated GET to the platform, authenticated by possession of the connect token like every other
// sandbox-originated call. node:https for the same reason platform-client.ts uses it: a dev platform arrives as
// a self-signed cert on host.docker.internal, and undici cannot skip verification for one request only.
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
    // A sandbox with no platform (a loopback or test daemon) can never have a trial: there is nobody to ask and
    // no account to meter it against. Same gate announcing uses.
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
                // Left as-is rather than cleared: a platform that blipped has not withdrawn the trial, and
                // dropping the endpoint mid-conversation would strand a turn the user is in the middle of.
                return;
            }
            // 404 is the platform's own "no trial here", for a platform that runs none, and for a sandbox it
            // does not recognise. Both mean the same thing to us, and both are final rather than transient.
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
