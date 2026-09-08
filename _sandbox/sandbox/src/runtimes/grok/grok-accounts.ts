import { setTimeout as sleep } from "node:timers/promises";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";

// xAI subscription OAuth relayed through OpenCode, which owns the protocol and token storage. Uses the headless
// device-code flow (the browser flow needs a loopback callback a remote daemon can't get): `start` returns the
// pre-filled verification URL, the poll below drives the exchange, no paste-back so no `complete`. OpenCode holds one
// xAI auth per data dir, so the list is 0 or 1 and its id is OpenCode's provider id.

// xAI's provider id in OpenCode / models.dev, and the single account's id.
const XAI = "xai";
// OpenCode exposes no connect timestamp; this account uses 0 to match the list shape of the others.
const grokAccount: OauthAccount = { id: XAI, label: "Grok", connectedAt: 0 };
// The device code's own lifetime: how long an attempt is polled for.
const DEVICE_WINDOW_MS = 15 * 60_000;

// Matched by label; confirm the exact string at runtime via provider.auth().
const isDeviceMethod = (label: string): boolean => /headless|device|remote|vps/i.test(label);

// `provider.oauth.callback` is a single poll of the device token endpoint (true once approved, false while pending);
// this drives the RFC 8628 poll until approval, expiry, or a superseding `start` abort.
const pollDeviceApproval = async (client: OpencodeClient, method: number, signal: AbortSignal): Promise<void> => {
    const deadline = Date.now() + DEVICE_WINDOW_MS;
    while (Date.now() < deadline && !signal.aborted) {
        try {
            await sleep(5_000, undefined, { signal });
        } catch {
            return; // superseded by a newer sign-in: stop polling the expired code
        }
        try {
            if ((await client.provider.oauth.callback({ path: { id: XAI }, body: { method } })).data === true) {
                return;
            }
        } catch {
            // authorization_pending / transient: keep polling until the deadline
        }
    }
};

export type GrokAccountDeps = Pick<Services, "openCode">;

export const grokAccountDoor = (services: GrokAccountDeps): AccountDoor => {
    // A superseding sign-in aborts the previous device poll to stop it hammering the expired code.
    let poll: { readonly handshake: string; readonly controller: AbortController } | undefined;
    return {
        start: async () => {
            const client = await services.openCode.client();
            const methods = (await client.provider.auth()).data?.[XAI] ?? [];
            const oauthMethods = methods.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "oauth");
            if (oauthMethods.length === 0) {
                throw new Error("xAI Grok OAuth is not available in this OpenCode build.");
            }
            // Prefer the headless/device method (remote daemon); fall back to the first oauth entry if labels don't
            // match.
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
            // The URL's `user_code` is authoritative; `instructions` can carry a stale code, used only as fallback.
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
