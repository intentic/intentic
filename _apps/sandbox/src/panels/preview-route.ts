import { portLabel, previewLabel, publicLabel } from "@intentic/sandbox-contract";
import { portSlotsFromToken, publicSlotFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { postToPlatform } from "../platform/platform-client.js";
import { discoverPanels, panelKey } from "./panels.js";

// Asks the platform to mint preview routes (proxied CNAMEs + tunnel ingress → the preview proxy) on the
// sandbox's intentic-provided tunnel, for a batch of `labels` — the first-DNS-label prefixes before
// `-<sandboxId>`: `preview-<panel>` for panel dev servers, `port-<slot>` for forwarded ports. Called BEFORE a
// hostname is handed to a browser, so it resolves by the time the iframe/tab loads — an early NXDOMAIN would
// get negative-cached for the zone's SOA TTL. Own-Cloudflare sandboxes get an `{ok:true}` no-op from the
// platform (their `*.<zone>` wildcard already serves the hostnames). Never rejects: a panel must start even
// when the platform is unreachable — the warn log is the operator's signal, and the next ensure retries.
// The boot-time sweep: one batched ensure covering every discovered repo's panel label, the whole port-slot
// pool, AND the outbox. Pre-minting the slots is what makes a port forward instant — by the time anyone
// Ctrl+clicks a localhost link, the port-<slot> hostnames have existed since boot, so DNS is warm and the
// forward is a pure in-daemon table update. The outbox is minted on the same principle and needs it more:
// publishing is a file move, with no moment slow enough to hide DNS propagation behind, so its record exists
// from boot whether or not anything has ever been published. Also the self-heal for repos created while the
// platform was unreachable. Cloudflare keeps routes across daemon restarts, so on the platform side this is
// usually all no-ops.
export const ensureAllPreviewRoutes = async (services: Services): Promise<void> => {
    const discovered = await discoverPanels(services.workspace);
    const keys = discovered.map(({ repo }) => panelKey(repo)).filter((key): key is string => key !== undefined);
    const slots = portSlotsFromToken(services.config.connectToken);
    const outbox = publicLabel(publicSlotFromToken(services.config.connectToken));
    await services.ensurePreviewRoutes([...keys.map(previewLabel), ...slots.map(portLabel), outbox]);
};

export const createPreviewRouteEnsurer = (config: Config, logger: Logger): ((labels: readonly string[]) => Promise<void>) => {
    // Labels already routed this boot — bounds Cloudflare traffic to one ensure per label per daemon lifetime
    // (the platform side is idempotent, so a daemon restart re-ensuring is cheap).
    const ensured = new Set<string>();
    // Serialize the platform calls: the ingress update is a read-modify-write of the whole tunnel config, so
    // two concurrent ensures could drop each other's routes.
    // ponytail: per-daemon serialization only — a multi-replica platform race self-heals on the next start.
    let tail = Promise.resolve();
    return (labels) => {
        if (config.platform.url === "" || config.connectToken === "") {
            return Promise.resolve();
        }
        tail = tail.then(async () => {
            const missing = labels.filter((label) => !ensured.has(label));
            if (missing.length === 0) {
                return;
            }
            try {
                const { status } = await postToPlatform(config, "/sandbox/preview-route", { labels: missing });
                if (status < 200 || status >= 300) {
                    logger.warn({ labels: missing, status }, "preview routes not minted — the preview hostnames may not resolve");
                    return;
                }
                for (const label of missing) {
                    ensured.add(label);
                }
            } catch (error) {
                logger.warn({ err: error, labels: missing }, "preview route request failed — the preview hostnames may not resolve");
            }
        });
        return tail;
    };
};
