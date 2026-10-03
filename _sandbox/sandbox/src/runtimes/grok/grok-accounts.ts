import { setTimeout as sleep } from "node:timers/promises";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { forgetAccountState } from "../../agent/providers/accounts/account-identity.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";

// xAI subscription OAuth relayed through OpenCode, which owns the protocol and token storage. Uses the headless
// device-code flow (the browser flow needs a loopback callback a remote daemon can't get): `start` returns the
// pre-filled verification URL, the poll below drives the exchange, no paste-back so no `complete`. OpenCode holds one
// xAI auth per data dir, so the list is 0 or 1 and its id is OpenCode's provider id.

const XAI = "xai";
const grokAccount: OauthAccount = { id: XAI, label: "Grok", connectedAt: 0 };
const DEVICE_WINDOW_MS = 15 * 60_000;
const isDeviceMethod = (label: string): boolean => /headless|device|remote|vps/i.test(label);
type PollPause = (signal: AbortSignal) => Promise<void>;
const pollPause: PollPause = async (signal) => void (await sleep(5_000, undefined, { signal }));

const startDevice = async (client: OpencodeClient): Promise<{ method: number; url: string; code: string }> => {
    const methods = (await client.provider.auth()).data?.[XAI] ?? [];
    const oauthMethods = methods.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "oauth");
    const method = oauthMethods.find(({ entry }) => isDeviceMethod(entry.label)) ?? oauthMethods[0];
    if (method === undefined) {
        throw new Error("xAI Grok OAuth is not available in this OpenCode build.");
    }
    const authorization = (await client.provider.oauth.authorize({ path: { id: XAI }, body: { method: method.index } })).data;
    if (authorization === undefined) {
        throw new Error("Could not start the xAI Grok sign-in.");
    }
    // The URL's user_code is authoritative; instructions can carry a stale code, used only as fallback.
    const code = new URL(authorization.url).searchParams.get("user_code") ?? authorization.instructions;
    return { method: method.index, url: authorization.url, code };
};

// OpenCode keeps pending authorizations in process memory, so the caller holds its runtime lease until this ends.
const pollDeviceApproval = async (client: OpencodeClient, method: number, signal: AbortSignal, pause: PollPause): Promise<void> => {
    while (!signal.aborted) {
        try {
            await pause(signal);
        } catch {
            return;
        }
        if (signal.aborted) {
            return;
        }
        try {
            if ((await client.provider.oauth.callback({ path: { id: XAI }, body: { method }, signal })).data === true) {
                return;
            }
        } catch {
            // authorization_pending / transient: keep polling until approval or the caller's deadline/cancellation.
        }
    }
};

export type GrokAccountDeps = Pick<Services, "openCode" | "headroom" | "observedLimits" | "providerRefusals">;

export const grokAccountDoor = (services: GrokAccountDeps, options: { readonly pause?: PollPause } = {}): AccountDoor => {
    let poll: { readonly handshake: string; readonly controller: AbortController } | undefined;
    return {
        start: async () => {
            const lease = await services.openCode.acquire({ providerID: XAI });
            let handedOff = false;
            try {
                const authorization = await startDevice(lease.client);
                poll?.controller.abort();
                const controller = new AbortController();
                const handshake = crypto.randomUUID();
                const expiresAt = Date.now() + DEVICE_WINDOW_MS;
                const expiry = setTimeout(() => controller.abort(), DEVICE_WINDOW_MS).unref();
                poll = { handshake, controller };
                void pollDeviceApproval(lease.client, authorization.method, controller.signal, options.pause ?? pollPause).finally(() => {
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
        list: async () => ((await services.openCode.connected(XAI)) ? [grokAccount] : []),
        rename: async () => {
            throw new Error("The Grok account is OpenCode's to name: it holds the credential, and there is only ever one.");
        },
        identityOf: () => undefined,
        forget: async (id) => {
            await Promise.all([services.openCode.disconnect(XAI), forgetAccountState(services, "grok", id)]);
        },
    };
};
