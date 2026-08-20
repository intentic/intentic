import type { Services } from "../composition.js";
import { extensionProcessKey } from "./extension-processes.js";
import { enabledExtensions } from "./installed-extensions.js";

/* The daemon's outbound leg of "speak as the agent" in a CHANNEL conversation (agents/place): the placed line
 * has an audience beyond the transcript, the Discord channel, Slack channel, Telegram chat or WhatsApp chat
 * the conversation was woken from, and this carries it there, through the loopback /deliver door every
 * connector gateway's shell serves (connector-runtime gateway.ts). The daemon still holds no provider
 * connection; the gateway process does, which is why this is an HTTP hop rather than an API call.
 *
 * "no-gateway" is an answer, not a failure: a webchat or webhook origin has no listener extension at all, and
 * a placed message there lands in the record alone exactly as it always did. A provider that DOES have a
 * gateway extension but no running process, or a gateway that refuses, throws instead, with the sentence the
 * caller shows the owner: silently placing a line the channel never saw is the transcript lying about what its
 * audience was told, which is the failure this whole path exists to prevent. */

// One loopback hop plus one provider API call (a chunked send is several), generous, and a gateway slower
// than this is wedged.
const DELIVER_TIMEOUT_MS = 30_000;

export type ListenerDeliverOutcome = "delivered" | "no-gateway";

export const deliverToListenerChannel = async (services: Services, provider: string, channelId: string, text: string): Promise<ListenerDeliverOutcome> => {
    for (const extension of await enabledExtensions(services)) {
        if (extension.manifest.contributes?.listener?.provider !== provider) {
            continue;
        }
        // The extension's first process with a live port is the gateway (listener extensions declare exactly
        // their gateway); no port means no running process, the automation was disabled or the sandbox is a
        // core image, and there is nothing to knock on.
        for (const process of extension.manifest.contributes?.processes ?? []) {
            const port = services.processes.portOf(extensionProcessKey(extension.id, process.name));
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
                // The body is the provider's own sentence (the shell puts the thrown message there), the most
                // actionable thing available, so it is what the owner reads.
                const detail = (await response.text().catch(() => "")).trim();
                throw new Error(detail !== "" ? detail : `the ${provider} gateway refused the message (${response.status})`);
            }
            return "delivered";
        }
        throw new Error(`the ${provider} gateway is not running, so the message cannot reach the channel`);
    }
    return "no-gateway";
};
