import type { AgentOrigin } from "@intentic/sandbox-contract";
import { z } from "zod";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import { outboxKeyOf } from "../../webchat/webchat-outbox.js";
import { extensionProcessKey } from "../extension-processes.js";
import { listenerOwnership } from "./listener-state.js";

// Daemon's outbound leg of "speak as the agent": delivers to the origin the conversation came from.
// A Visitor chat is answered in the daemon itself (the visitor's browser polls for it); every other provider goes over
// loopback /deliver, since the gateway holds the provider connection and the daemon does not.
// "no-gateway" is valid (no listener extension); a broken or stopped one throws instead of silently dropping it.

// One loopback hop plus a provider API call (more for a chunked send); slower than this and the gateway is wedged.
const DELIVER_TIMEOUT_MS = 30_000;

export type ListenerDeliverOutcome = "delivered" | "no-gateway";

export const deliverToListenerChannel = async (services: Services, origin: AgentOrigin, text: string): Promise<ListenerDeliverOutcome> => {
    if (origin.channelId === undefined) {
        return "no-gateway";
    }
    // Checked before the extension walk: a Visitor chat has no gateway and never will, so falling through to one would
    // report "nothing is listening" about the one provider the daemon answers itself.
    const outbox = outboxKeyOf(origin);
    if (outbox !== undefined) {
        await services.webchatOutbox.append(outbox, text, Date.now());
        return "delivered";
    }
    return (await deliverThroughGateway(services, origin.provider, origin.channelId, text)) === undefined ? "no-gateway" : "delivered";
};

// What a gateway said about the message it posted: a link to it, when the provider gives one (Discord does).
export interface GatewayDelivery {
    readonly url?: string;
}

// The body of a 200 from /deliver: JSON from today's connector runtime, a bare "ok" from an older gateway; either way
// the message went, and only a link the gateway named is passed on.
const DeliveredBodySchema = z.object({ url: z.string().min(1) });

export const gatewayDeliveryOf = (body: string): GatewayDelivery => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        // allow(silent-catch): a body that is not JSON is an older gateway's bare "ok", which names no link
        return {};
    }
    const named = DeliveredBodySchema.safeParse(parsed);
    return named.success ? { url: named.data.url } : {};
};

// A gateway's answer body, or "" when the body itself could not be read: the caller words a refusal from the status
// instead, and a delivery simply names no link.
const bodyOf = (response: Response): Promise<string> =>
    // allow(silent-catch): an unreadable body has a fallback at both callers, and the status already said what happened
    response.text().catch(() => "");

// One POST to a gateway's /deliver. Read by the owner when it fails (a failed approval row, a chat notice), so a
// wedged gateway is named rather than the abort that ended the wait.
const postToGateway = async (port: number, provider: string, channelId: string, text: string): Promise<Response> => {
    try {
        return await fetch(`http://127.0.0.1:${port}/deliver`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channelId, text }),
            signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new Error(`the ${provider} gateway did not answer within ${DELIVER_TIMEOUT_MS / 1_000}s, so the message may not have gone`, { cause: error });
        }
        throw error;
    }
};

// The extension half: the extension that owns this provider's listener (listener-state.ts), asked over its own loopback
// port. Never another declarer's: the reply is the agent's words to the owner's channel. Undefined when no enabled
// extension listens on this provider. Walks the same cached inventory the ownership is read from, not a fresh one per
// message.
export const deliverThroughGateway = async (services: Services, provider: string, channelId: string, text: string): Promise<GatewayDelivery | undefined> => {
    const owner = (await listenerOwnership(services)).owners.get(provider);
    for (const extension of await cachedEnabledExtensions(services)) {
        if (extension.manifest.contributes?.listener?.provider !== provider || (owner !== undefined && extension.id !== owner)) {
            continue;
        }
        // First process with a live port is the gateway; no port means nothing running (disabled or a core image).
        for (const process of extension.manifest.contributes?.processes ?? []) {
            const port = services.serviceProcesses.portOf(extensionProcessKey(extension.id, process.name));
            if (port === undefined) {
                continue;
            }
            const response = await postToGateway(port, provider, channelId, text);
            if (!response.ok) {
                // Body is the provider's own thrown message, put there by the shell; the most actionable text there is.
                const detail = (await bodyOf(response)).trim();
                throw new Error(detail !== "" ? detail : `the ${provider} gateway refused the message (${response.status})`);
            }
            return gatewayDeliveryOf(await bodyOf(response));
        }
        throw new Error(`the ${provider} gateway is not running, so the message cannot reach the channel`);
    }
    return undefined;
};
