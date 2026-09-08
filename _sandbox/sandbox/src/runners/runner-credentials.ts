import {
    type RunnerCredential,
    RunnerCredentialRefreshSchema,
    type RunnerCredentialRequest,
    RunnerCredentialSchema,
    runnerCredentialRefreshUrl,
    runnerCredentialsUrl,
    runnerTranslatorUrl,
} from "@intentic/sandbox-contract";
import type { HarnessCredentialsResult } from "../agent/providers/harness-credentials.js";
import type { RunnerIdentity } from "./runner-identity.js";

// The runner's side of the credential doors: a dispatched turn asks the origin sandbox for its credential per turn over
// HTTPS, translated back into the same shape local resolution produces. The refresh hook re-mints at the parent when
// the API rejects the held token; `current` tracks it so the parent supersedes exactly that one.

// On the turn's critical path: a parent too slow to answer is one to fall back from, not wait on.
const RESOLVE_TIMEOUT_MS = 30_000;

export interface ParentCredentials {
    readonly resolve: (input: { readonly agent?: string; readonly account?: string; readonly model?: string }) => Promise<HarnessCredentialsResult>;
}

const post = async (url: string, token: string, body: object, timeoutMs: number): Promise<unknown> => {
    const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new Error(`the parent answered ${response.status}`);
    }
    return await response.json();
};

export const parentCredentialSource = (identity: RunnerIdentity, logger: { warn: (data: object, message: string) => void }): ParentCredentials => {
    const refreshHook = (first: string, account: string) => {
        let current: string | undefined = first;
        return async ({ signal }: { readonly signal: AbortSignal }): Promise<string | undefined> => {
            if (current === undefined) {
                return undefined;
            }
            try {
                const response = await fetch(runnerCredentialRefreshUrl(identity.parentUrl), {
                    method: "POST",
                    headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
                    body: JSON.stringify({ account, rejected: current }),
                    signal,
                });
                if (!response.ok) {
                    throw new Error(`the parent answered ${response.status}`);
                }
                const minted = RunnerCredentialRefreshSchema.parse(await response.json()).accessToken;
                current = minted;
                return minted;
            } catch (error) {
                logger.warn({ err: error, account }, "runner: mid-turn re-mint at the parent failed");
                return undefined;
            }
        };
    };

    return {
        resolve: async (input) => {
            const body: RunnerCredentialRequest = {
                ...(input.agent !== undefined ? { agent: input.agent } : {}),
                ...(input.account !== undefined ? { account: input.account } : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
            };
            const answer: RunnerCredential = RunnerCredentialSchema.parse(
                await post(runnerCredentialsUrl(identity.parentUrl), identity.token, body, RESOLVE_TIMEOUT_MS),
            );
            if (!answer.ok) {
                return { ok: false, ...(answer.code !== undefined ? { code: answer.code } : {}), message: answer.message };
            }
            switch (answer.kind) {
                case "oauth":
                    return {
                        ok: true,
                        credentials: {
                            oauthToken: answer.accessToken,
                            ...(answer.account !== undefined
                                ? { account: answer.account, refreshOauthToken: refreshHook(answer.accessToken, answer.account) }
                                : {}),
                        },
                    };
                case "parent-translator":
                    // The bearer stays this runner's own token; the parent's proxy swaps in the translator's local one.
                    return {
                        ok: true,
                        credentials: {
                            endpoint: { baseUrl: runnerTranslatorUrl(identity.parentUrl), authToken: identity.token, model: answer.model },
                            ...(answer.trial === true ? { trial: true } : {}),
                        },
                    };
                case "endpoint":
                    return {
                        ok: true,
                        credentials: {
                            endpoint: { baseUrl: answer.baseUrl, authToken: answer.authToken, model: answer.model },
                            ...(answer.trial === true ? { trial: true } : {}),
                        },
                    };
            }
        },
    };
};
