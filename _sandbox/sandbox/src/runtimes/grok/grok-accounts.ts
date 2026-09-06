import { setTimeout as sleep } from "node:timers/promises";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";

/* GROK'S ACCOUNT DOOR (agent/provider-module.ts): xAI's subscription OAuth, relayed through OpenCode, which owns
 * the protocol and the token storage. xAI offers two OAuth methods (both type "oauth"): a browser flow that
 * waits on a 127.0.0.1 loopback callback, which can never fire for a remote daemon, and a headless device-code
 * flow, which is the one used: `start` returns the verification URL with the one-time code pre-filled, the
 * user approves at x.ai, and the poll below drives the token exchange to completion. No paste-back, so no
 * `complete`; the card watches the account list.
 *
 * OpenCode holds ONE xAI auth per data dir, so the list is 0 or 1 and the account's id is OpenCode's provider
 * id. Renaming it is OpenCode's business, not this store's, and says so. */

// The xAI provider id in OpenCode / models.dev, also the single account's id.
const XAI = "xai";
// OpenCode doesn't expose a connect timestamp; the single account uses 0 so its list shape matches the others.
const grokAccount: OauthAccount = { id: XAI, label: "Grok", connectedAt: 0 };
// The device code's own lifetime, which is how long an attempt is polled for.
const DEVICE_WINDOW_MS = 15 * 60_000;

// Matched by label; confirm the exact string at runtime via provider.auth().
const isDeviceMethod = (label: string): boolean => /headless|device|remote|vps/i.test(label);

// OpenCode's provider.oauth.callback is a SINGLE poll of the device token endpoint (true once approved, false
// while pending), it doesn't loop. So drive the RFC 8628 poll ourselves until the user approves, the code
// expires, or a superseding `start` aborts us. Detached from the `start` answer.
const pollDeviceApproval = async (client: OpencodeClient, method: number, signal: AbortSignal): Promise<void> => {
    const deadline = Date.now() + DEVICE_WINDOW_MS;
    while (Date.now() < deadline && !signal.aborted) {
        try {
            await sleep(5_000, undefined, { signal });
        } catch {
            return; // superseded by a newer sign-in: stop polling the now-expired code
        }
        try {
            if ((await client.provider.oauth.callback({ path: { id: XAI }, body: { method } })).data === true) {
                return;
            }
        } catch {
            // authorization_pending / transient, keep polling until the deadline.
        }
    }
};

export type GrokAccountDeps = Pick<Services, "openCode">;

export const grokAccountDoor = (services: GrokAccountDeps): AccountDoor => {
    // A superseding sign-in aborts the previous device poll so it stops hammering the now-expired code.
    let poll: { readonly handshake: string; readonly controller: AbortController } | undefined;
    return {
        start: async () => {
            const client = await services.openCode.client();
            const methods = (await client.provider.auth()).data?.[XAI] ?? [];
            const oauthMethods = methods.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "oauth");
            if (oauthMethods.length === 0) {
                throw new Error("xAI Grok OAuth is not available in this OpenCode build.");
            }
            // Prefer the headless/device method (remote daemon); fall back to the first oauth if labels don't match.
            const method = (oauthMethods.find(({ entry }) => isDeviceMethod(entry.label)) ?? oauthMethods[0]!).index;
            const authorization = (await client.provider.oauth.authorize({ path: { id: XAI }, body: { method } })).data;
            if (authorization === undefined) {
                throw new Error("Could not start the xAI Grok sign-in.");
            }
            poll?.controller.abort();
            const controller = new AbortController();
            const handshake = crypto.randomUUID();
            poll = { handshake, controller };
            void pollDeviceApproval(client, method, controller.signal);
            // Surface the code the URL pre-fills (the single source of truth) so the card matches x.ai exactly,
            // `instructions` has been observed to carry a different/stale code. Fall back to it only if absent.
            const code = new URL(authorization.url).searchParams.get("user_code") ?? authorization.instructions;
            return { url: authorization.url, code, state: "", flow: "device", variant: "", handshake, expiresAt: Date.now() + DEVICE_WINDOW_MS };
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
        disconnect: async () => {
            await services.openCode.disconnect(XAI);
        },
    };
};
