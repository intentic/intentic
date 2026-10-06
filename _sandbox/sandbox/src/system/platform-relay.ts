import type { Config } from "../env.config.js";
import { type CliAnswer, jsonAnswer } from "../http/cli-answer.js";
import { type DaemonIngressRoute, exchangeWithPlatform, type IngressCall, ingressExchange } from "./platform-client.js";

// One platform call onto its non-session routes, relayed untouched since a refusal is already written for its reader.

// WHAT A CALL PRESENTS TO PROVE WHO IS ASKING is the route's to say (its `auth` in api-contract's PLATFORM_INGRESS). The
// connect token names this SANDBOX and reaches only its own routes; a provisioning token, handed in as `bearer`, names
// the owner's ACCOUNT and reaches only /fleet. Disjoint on purpose, so a leaked credential is bounded by the door it was
// minted for rather than by what the holder thinks to try.
export interface PlatformCall<K extends DaemonIngressRoute> extends Pick<IngressCall<K>, "route" | "input" | "bearer"> {
    // What a dead or absent platform did NOT do, in the caller's own words: the sentence is read by a person deciding
    // whether to retry, and "nothing was charged" and "nothing was created" settle different worries.
    readonly unreached: string;
}

export const callPlatform = async <K extends DaemonIngressRoute>(config: Config, call: PlatformCall<K>): Promise<CliAnswer> => {
    // Quick calls only, so a dead platform is cut short.
    const { unreached, ...route } = call;
    const exchange = ingressExchange(config, { ...route, idleMs: 30_000, idleError: "timeout" });
    // The one case that can't actually be relayed: no platform, or no credential for the door being knocked on.
    if (config.platform.url === "" || exchange === undefined) {
        return jsonAnswer(502, { error: "this sandbox is not connected to a platform" });
    }
    try {
        const answer = await exchangeWithPlatform(config, exchange);
        return { status: answer.status === 0 ? 502 : answer.status, body: answer.body, contentType: answer.contentType ?? "application/json" };
    } catch {
        // allow(silent-catch): an unreachable platform is answered as one, in the caller's own words about what did not happen.
        return jsonAnswer(502, { error: `the platform could not be reached, ${unreached}` });
    }
};
