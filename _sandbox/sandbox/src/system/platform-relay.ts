import type { Config } from "../env.config.js";
import { type CliAnswer, jsonAnswer } from "../http/cli-answer.js";
import { exchangeWithPlatform } from "./platform-client.js";

// One platform call onto its non-session routes, relayed untouched since a refusal is already written for its reader.

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

export const callPlatform = async (config: Config, call: PlatformCall): Promise<CliAnswer> => {
    const auth = headerFor(config, call.auth);
    // The one case that can't actually be relayed: no platform, or no credential for the door being knocked on.
    if (config.platform.url === "" || auth === undefined) {
        return jsonAnswer(502, { error: "this sandbox is not connected to a platform" });
    }
    try {
        // Quick calls only, so a dead platform is cut short.
        const answer = await exchangeWithPlatform(config, {
            method: call.method,
            path: call.path,
            headers: auth,
            ...(call.payload === undefined ? {} : { payload: call.payload }),
            idleMs: 30_000,
            idleError: "timeout",
        });
        return { status: answer.status === 0 ? 502 : answer.status, body: answer.body, contentType: answer.contentType ?? "application/json" };
    } catch {
        // allow(silent-catch): an unreachable platform is answered as one, in the caller's own words about what did not happen.
        return jsonAnswer(502, { error: `the platform could not be reached, ${call.unreached}` });
    }
};
