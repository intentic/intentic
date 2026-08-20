import { request } from "node:https";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./local-tls.js";

/* IS THIS SANDBOX'S OWNER A MEMBER, the daemon's side of the premium gate, asked of the platform's
 * /pool/status with the connect token, the trial-status pattern (one authenticated GET, node:https for the
 * same self-signed-dev-cert reason platform-client.ts spells out).
 *
 * Asked AT THE GATE (installing or enabling a premium extension) rather than cached on a poll: the moments
 * that need the answer are rare, human-paced, and worth a fresh read, a cached "no" minutes after someone
 * paid is a support ticket, and a cached "yes" after a lapse is a lie. Fail-closed with the reason: an
 * unreachable platform refuses the enable and says the problem is reach, not money. */

export interface PremiumStatus {
    readonly premium: boolean;
    // Why, when the answer is no, already in the user's terms.
    readonly detail?: string;
}

export const premiumStatus = (config: Config): Promise<PremiumStatus> =>
    new Promise((resolve) => {
        if (config.platform.url === "" || config.connectToken === "") {
            resolve({ premium: false, detail: "this sandbox is not connected to a platform, and premium extensions need one" });
            return;
        }
        const url = new URL("/pool/status", config.platform.url);
        const req = request(
            url,
            { method: "GET", headers: { "x-intentic-connect": config.connectToken }, rejectUnauthorized: !isLocalHost(url.hostname) },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                response.on("end", () => {
                    if (response.statusCode === 200) {
                        let premium = false;
                        try {
                            premium = (JSON.parse(raw) as { premium?: unknown }).premium === true;
                        } catch {
                            // A 200 that doesn't parse falls through to the honest no below.
                        }
                        resolve(premium ? { premium: true } : { premium: false, detail: "this account has no active intentic membership" });
                        return;
                    }
                    resolve({ premium: false, detail: "this platform offers no memberships" });
                });
            },
        );
        req.on("error", () => resolve({ premium: false, detail: "the platform could not be reached to confirm the membership" }));
        req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
        req.end();
    });
