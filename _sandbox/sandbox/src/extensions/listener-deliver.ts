import type { Services } from "../composition.js";
import { extensionProcessKey } from "./extension-processes.js";
import { enabledExtensions } from "./installed-extensions.js";

// Daemon's outbound leg of "speak as the agent": delivers to its Discord/Slack/Telegram/WhatsApp origin.
// Goes over loopback /deliver since the gateway holds the provider connection, not the daemon.
// "no-gateway" is valid (no listener extension); a broken or stopped one throws instead of silently dropping it.

// One loopback hop plus a provider API call (more for a chunked send); slower than this and the gateway is wedged.
const DELIVER_TIMEOUT_MS = 30_000;

export type ListenerDeliverOutcome = "delivered" | "no-gateway";

export const deliverToListenerChannel = async (services: Services, provider: string, channelId: string, text: string): Promise<ListenerDeliverOutcome> => {
    for (const extension of await enabledExtensions(services)) {
        if (extension.manifest.contributes?.listener?.provider !== provider) {
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
