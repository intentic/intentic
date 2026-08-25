import {
    type RunnerCredential,
    RunnerCredentialRefreshSchema,
    type RunnerCredentialRequest,
    RunnerCredentialSchema,
    runnerCredentialRefreshUrl,
    runnerCredentialsUrl,
    runnerTranslatorUrl,
} from "@intentic/sandbox-contract";
import type { HarnessCredentialsResult } from "../agent/harness-credentials.js";
import type { RunnerIdentity } from "./runner-identity.js";

/* THE RUNNER'S SIDE of the credential doors: a dispatched turn authenticates with whatever the ORIGIN
 * sandbox would have used, asked for per turn over HTTPS with this runner's own token. The answer is
 * translated back into exactly the shape local resolution produces (HarnessCredentialsResult), so
 * everything downstream — harnessEnv, the withholding rule, the connect-gate refusal rendering — cannot
 * tell a forwarded credential from a stored one.
 *
 * The mid-turn refresh hook is the door's second half: the harness calls it when the API refuses the token
 * it holds, and the re-mint runs at the PARENT, against the store with the refresh token. `current` tracks
 * what this harness holds so the parent supersedes exactly that one (the same rule local rotation keeps). */

// A resolution is one small POST on the turn's critical path; a parent that cannot answer this fast is a
// parent the turn should fall back from rather than wait on.
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
                    // The bearer is this runner's OWN token: the parent's proxy verifies it and swaps in the
                    // translator's local one, so no translator credential ever reached this box.
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
