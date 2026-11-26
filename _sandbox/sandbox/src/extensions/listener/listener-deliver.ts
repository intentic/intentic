import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import type { ListenerDeliver } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { z } from "zod";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { listenerOwnership } from "./listener-state.js";
import { extensionProcessKey } from "../../capabilities/extension-dirs.js";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";

// Daemon's outbound leg of "speak as the agent": delivers to the origin the conversation came from, over loopback
// /deliver, since the gateway holds the provider connection and the daemon does not. (2026-11-26) The Visitor chat's
// is its extension's gateway too, which keeps the visitor's outbox; the daemon answered it itself until then.
// "no-gateway" is valid (no listener extension); a broken or stopped one throws instead of silently dropping it.
// This is the one-try leg, for a person placing words who is told at once if they did not go; what nobody waits on (a
// held wake's answer, a decline, a need's ask) is owed through listener-outbox.ts instead, which keeps trying.

// One loopback hop plus a provider API call (more for a chunked send); slower than this and the gateway is wedged.
const DELIVER_TIMEOUT_MS = 30_000;

export type ListenerDeliverOutcome = "delivered" | "no-gateway";

export const deliverToListenerChannel = async (services: Services, origin: AgentOrigin, text: string): Promise<ListenerDeliverOutcome> => {
    if (origin.channelId === undefined) {
        return "no-gateway";
    }
    return (await deliverThroughGateway(services, origin.provider, origin.channelId, text, origin.threadId)) === undefined ? "no-gateway" : "delivered";
};

// What a gateway said about the message it posted: a link to it, when the provider gives one (Discord does).
export interface GatewayDelivery {
    readonly url?: string;
}

// The body of a 200 from /deliver: JSON from today's connector runtime, a bare "ok" from an older gateway; either way
// the message went, and only a link the gateway named is passed on.
const DeliveredBodySchema = z.object({ url: z.string().min(1) });

export const gatewayDeliveryOf = (body: string): GatewayDelivery => {
    const parsed = parseJsonOr(body, undefined);
    if (parsed === undefined) {
        // A body that is not JSON is an older gateway's bare "ok", which names no link.
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

// Why a gateway delivery failed, as the reply outbox (listener-outbox.ts) decides whether to try it again:
// - `unreachable`: nothing took the request (no gateway running, the connection refused), so nothing was posted;
// - `ambiguous`: the request went and no answer came back (a timeout, a connection cut mid-answer), so it may have posted;
// - `failed`: the gateway answered that the provider refused or failed the post (a 502), which may pass;
// - `refused`: the gateway cannot ever take it (a 4xx, a connector with no delivery), which will not.
export type GatewayFailure = "unreachable" | "ambiguous" | "failed" | "refused";

export class GatewayDeliveryError extends Error {
    readonly failure: GatewayFailure;

    constructor(message: string, failure: GatewayFailure, options?: ErrorOptions) {
        super(message, options);
        this.name = "GatewayDeliveryError";
        this.failure = failure;
    }
}

// A connection refused is a gateway not listening yet; anything else fetch throws may come after the body went.
const ConnectionCauseSchema = z.object({ code: z.string() });
const refusedConnection = (error: Error): boolean => ConnectionCauseSchema.safeParse(error.cause).data?.code === "ECONNREFUSED";

// One POST to a gateway's /deliver (the contract's ListenerDeliver). Read by the owner when it fails (a failed approval
// row, a chat notice), so a wedged gateway is named rather than the abort that ended the wait.
const postToGateway = async (port: number, provider: string, body: ListenerDeliver): Promise<Response> => {
    try {
        return await fetch(`http://127.0.0.1:${port}/deliver`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new GatewayDeliveryError(`the ${provider} gateway did not answer within ${DELIVER_TIMEOUT_MS / 1_000}s, so the message may not have gone`, "ambiguous", {
                cause: error,
            });
        }
        const failure = error instanceof Error && refusedConnection(error) ? "unreachable" : "ambiguous";
        throw new GatewayDeliveryError(`the ${provider} gateway could not be reached: ${errorMessage(error)}`, failure, { cause: error });
    }
};

// What a gateway's answer says of the post: where it went, or why it did not.
const answerOf = async (provider: string, response: Response): Promise<GatewayDelivery> => {
    if (!response.ok) {
        // Body is the provider's own thrown message, put there by the shell; the most actionable text there is.
        const detail = (await bodyOf(response)).trim();
        // A 5xx is the provider failing this post, which may pass; anything else the gateway will never take.
        throw new GatewayDeliveryError(
            detail !== "" ? detail : `the ${provider} gateway refused the message (${response.status})`,
            response.status >= 500 ? "failed" : "refused",
        );
    }
    return gatewayDeliveryOf(await bodyOf(response));
};

// The extension half: the extension that owns this provider's listener (listener-state.ts), asked over its own loopback
// port. Never another declarer's: the reply is the agent's words to the owner's channel. `thread` puts it into that
// thread of the channel rather than onto the channel itself. `id` names the reply for a gateway that posts one id once
// (the contract's DELIVER_ID_FEATURE). Undefined when no enabled extension listens on this provider. Walks the same
// cached inventory the ownership is read from, not a fresh one per message. Throws a GatewayDeliveryError.
export const deliverThroughGateway = async (
    services: Services,
    provider: string,
    channelId: string,
    text: string,
    thread?: string,
    id?: string,
): Promise<GatewayDelivery | undefined> => {
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
            return answerOf(provider, await postToGateway(port, provider, { channelId, text, ...opt("thread", thread), ...opt("id", id) }));
        }
        throw new GatewayDeliveryError(`the ${provider} gateway is not running, so the message cannot reach the channel`, "unreachable");
    }
    return undefined;
};
