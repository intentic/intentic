import { setTimeout as sleep } from "node:timers/promises";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { grokContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// The xAI provider id in OpenCode / models.dev, also the single account's id (OpenCode holds one xAI auth).
const XAI = "xai";
// OpenCode doesn't expose a connect timestamp; the single account uses 0 so its list shape matches the others.
const grokAccount = { id: XAI, label: "Grok", connectedAt: 0 };

// xAI offers two OAuth methods (both type "oauth"): a browser flow that waits on a 127.0.0.1 loopback callback,
// and a headless device-code flow. The daemon is remote, so the loopback can never fire, we must use the
// device method (verification URL + one-time code the user enters at x.ai, completed by polling). Matched by
// label; confirm the exact string at runtime via provider.auth().
const isDeviceMethod = (label: string): boolean => /headless|device|remote|vps/i.test(label);

// OpenCode's provider.oauth.callback is a SINGLE poll of the device token endpoint (true once approved, false
// while pending), it doesn't loop. So drive the RFC 8628 poll ourselves until the user approves, the code
// expires (~15 min), or a superseding `start` aborts us. Detached from the `start` response; the UI polls
// /grok/accounts for the connected flip.
const pollDeviceApproval = async (client: OpencodeClient, method: number, signal: AbortSignal): Promise<void> => {
    const deadline = Date.now() + 15 * 60_000;
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

export type GrokRoutesDeps = Pick<Services, "openCode">;

// xAI Grok OAuth, relayed through OpenCode (which owns the protocol + token storage). `start` authorizes xAI's
// device-code method and returns the URL + instructions (the instructions carry the one-time code the user
// enters at x.ai); OpenCode then polls to completion, there is no paste-back. `accounts` reflects OpenCode's
// connection view; `disconnect` clears the stored tokens.
export const createGrokRoutes = (services: GrokRoutesDeps) => {
    const i = implement(grokContract).$context<OrpcContext>();
    // A superseding sign-in aborts the previous device poll so it stops hammering the now-expired code.
    let pollController: AbortController | undefined;
    return {
        start: i.start.handler(async () => {
            const client = await services.openCode.client();
            const methods = (await client.provider.auth()).data?.[XAI] ?? [];
            const oauthMethods = methods.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "oauth");
            if (oauthMethods.length === 0) {
                throw new ORPCError("BAD_REQUEST", { message: "xAI Grok OAuth is not available in this OpenCode build." });
            }
            // Prefer the headless/device method (remote daemon); fall back to the first oauth if labels don't match.
            const method = (oauthMethods.find(({ entry }) => isDeviceMethod(entry.label)) ?? oauthMethods[0]!).index;
            const authorization = (await client.provider.oauth.authorize({ path: { id: XAI }, body: { method } })).data;
            if (authorization === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "Could not start the xAI Grok sign-in." });
            }
            // The device grant has no paste-back: the URL is xAI's verification_uri_complete with the code
            // pre-filled (`?user_code=…`). Drive the poll-to-completion loop in the background (awaited nowhere);
            // the UI polls /grok/accounts until connected.
            pollController?.abort();
            pollController = new AbortController();
            void pollDeviceApproval(client, method, pollController.signal);
            // Surface the code the URL pre-fills (the single source of truth) so the card matches x.ai exactly,
            // `instructions` has been observed to carry a different/stale code. Fall back to it only if absent.
            const code = new URL(authorization.url).searchParams.get("user_code") ?? authorization.instructions;
            return { url: authorization.url, code };
        }),
        accounts: i.accounts.handler(async () => ({ accounts: (await services.openCode.connected(XAI)) ? [grokAccount] : [] })),
        disconnect: i.disconnect.handler(async () => {
            await services.openCode.disconnect(XAI);
            return { ok: true } as const;
        }),
    };
};
