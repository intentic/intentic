import { setTimeout as sleep } from "node:timers/promises";
import type { OpenCodeClient } from "@opencode/client";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { forgetAccountState } from "../../agent/providers/accounts/account-identity.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { OPENCODE_XAI_PROVIDER } from "../opencode/xai-models.js";

// xAI subscription OAuth relayed through OpenCode, which owns the protocol and token storage. Uses the headless
// device-code flow (the browser flow needs a loopback callback a remote daemon can't get): `start` returns the
// pre-filled verification URL, the poll below waits on OpenCode's own exchange, no paste-back so no `complete`. This
// door keeps one xAI sign-in, so the list is 0 or 1 and its id is OpenCode's provider id.

const grokAccount: OauthAccount = { id: OPENCODE_XAI_PROVIDER, label: "Grok", connectedAt: 0 };
// OpenCode 2's id for xAI's device-code method ("SuperGrok Subscription").
const DEVICE_METHOD = "device";
// The longest a sign-in is waited on, whatever OpenCode says its attempt allows.
const DEVICE_WINDOW_MS = 15 * 60_000;
type PollPause = (signal: AbortSignal) => Promise<void>;
const pollPause: PollPause = async (signal) => void (await sleep(5_000, undefined, { signal }));

// OpenCode loads its integration catalog just after it starts listening; until then it answers that xAI is unknown.
const CATALOG_WAIT_MS = 10_000;
const awaitIntegration = async (client: OpenCodeClient): Promise<void> => {
    const deadline = Date.now() + CATALOG_WAIT_MS;
    for (;;) {
        try {
            await client.integration.get({ integrationID: OPENCODE_XAI_PROVIDER });
            return;
        } catch (error) {
            if ((error as { readonly name?: unknown }).name !== "IntegrationNotFoundError" || Date.now() > deadline) {
                throw error;
            }
        }
        await sleep(250);
    }
};

const startDevice = async (client: OpenCodeClient): Promise<{ attempt: string; url: string; code: string; expiresAt: number }> => {
    await awaitIntegration(client);
    const { data } = await client.integration.oauth.connect({ integrationID: OPENCODE_XAI_PROVIDER, methodID: DEVICE_METHOD });
    // The URL's user_code is authoritative; the instructions say the same code in a sentence, the fallback.
    const code = new URL(data.url).searchParams.get("user_code") ?? data.instructions;
    return { attempt: data.attemptID, url: data.url, code, expiresAt: Math.min(data.time.expires, Date.now() + DEVICE_WINDOW_MS) };
};

// OpenCode exchanges the device code itself and keeps the attempt in process memory, so the caller holds its runtime
// lease until this ends; an attempt given up on is cancelled, which stops OpenCode polling xAI for it.
const pollDeviceApproval = async (client: OpenCodeClient, attempt: string, signal: AbortSignal, pause: PollPause): Promise<void> => {
    while (!signal.aborted) {
        try {
            await pause(signal);
        } catch {
            break;
        }
        if (signal.aborted) {
            break;
        }
        try {
            const { data } = await client.integration.oauth.status({ integrationID: OPENCODE_XAI_PROVIDER, attemptID: attempt }, { signal });
            if (data.status !== "pending") {
                return;
            }
        } catch (error) {
            // An attempt OpenCode no longer knows is over; anything else is transient: keep polling until approval or
            // the caller's deadline or cancellation.
            if ((error as { readonly name?: unknown }).name === "IntegrationAttemptNotFoundError") {
                return;
            }
        }
    }
    // allow(silent-catch): an attempt that already ended has nothing left to cancel
    await client.integration.oauth.cancel({ integrationID: OPENCODE_XAI_PROVIDER, attemptID: attempt }).catch(() => {});
};

export type GrokAccountDeps = Pick<Services, "openCode" | "headroom" | "observedLimits" | "providerRefusals">;

export const grokAccountDoor = (services: GrokAccountDeps, options: { readonly pause?: PollPause } = {}): AccountDoor => {
    let poll: { readonly handshake: string; readonly controller: AbortController } | undefined;
    return {
        start: async () => {
            const lease = await services.openCode.acquire({ providerID: OPENCODE_XAI_PROVIDER });
            let handedOff = false;
            try {
                const authorization = await startDevice(lease.client);
                poll?.controller.abort();
                const controller = new AbortController();
                const handshake = crypto.randomUUID();
                const { expiresAt } = authorization;
                const expiry = setTimeout(() => controller.abort(), Math.max(0, expiresAt - Date.now())).unref();
                poll = { handshake, controller };
                void pollDeviceApproval(lease.client, authorization.attempt, controller.signal, options.pause ?? pollPause).finally(() => {
                    clearTimeout(expiry);
                    if (poll?.handshake === handshake) {
                        poll = undefined;
                    }
                    lease.release();
                });
                handedOff = true;
                return { url: authorization.url, code: authorization.code, state: "", flow: "device", variant: "", handshake, expiresAt };
            } finally {
                if (!handedOff) {
                    lease.release();
                }
            }
        },
        cancel: (handshake) => {
            if (poll?.handshake === handshake) {
                poll.controller.abort();
                poll = undefined;
            }
        },
        list: async () => ((await services.openCode.connected(OPENCODE_XAI_PROVIDER)) ? [grokAccount] : []),
        rename: async () => {
            throw new Error("The Grok account is OpenCode's to name: it holds the credential, and there is only ever one.");
        },
        identityOf: () => undefined,
        forget: async (id) => {
            await Promise.all([services.openCode.disconnect(OPENCODE_XAI_PROVIDER), forgetAccountState(services, "grok", id)]);
        },
    };
};
