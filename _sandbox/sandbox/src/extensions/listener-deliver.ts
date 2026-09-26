import type { AgentOrigin } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { outboxKeyOf } from "../webchat/webchat-outbox.js";
import { extensionProcessKey } from "./extension-processes.js";
import { enabledExtensions } from "./installed-extensions.js";
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
    return viaGateway(services, origin.provider, origin.channelId, text);
};

// The extension half: the extension that owns this provider's listener (listener-state.ts), asked over its own loopback
// port. Never another declarer's: the reply is the agent's words to the owner's channel.
const viaGateway = async (services: Services, provider: string, channelId: string, text: string): Promise<ListenerDeliverOutcome> => {
    const owner = (await listenerOwnership(services)).owners.get(provider);
    for (const extension of await enabledExtensions(services)) {
        if (extension.manifest.contributes?.listener?.provider !== provider || (owner !== undefined && extension.id !== owner)) {
            continue;
        }
        // First process with a live port is the gateway; no port means nothing running (disabled or a core image).
        for (const process of extension.manifest.contributes?.processes ?? []) {
            const port = services.serviceProcesses.portOf(extensionProcessKey(extension.id, process.name));
            if (port === undefined) {
                continue;
            }
            const response = await fetch(`http://127.0.0.1:${port}/deliver`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ channelId, text }),
                signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
            });
            if (!response.ok) {
                // Body is the provider's own thrown message, put there by the shell; the most actionable text there is.
                const detail = (await response.text().catch(() => "")).trim();
                throw new Error(detail !== "" ? detail : `the ${provider} gateway refused the message (${response.status})`);
            }
            return "delivered";
        }
        throw new Error(`the ${provider} gateway is not running, so the message cannot reach the channel`);
    }
    return "no-gateway";
};
