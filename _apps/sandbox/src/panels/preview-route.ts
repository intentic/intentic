import { previewLabel } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { postToPlatform } from "../platform/platform-client.js";
import { discoverPanels, panelKey } from "./panels.js";

// Asks the platform to mint a preview route (proxied CNAME + tunnel ingress → the preview proxy) on the
// sandbox's intentic-provided tunnel, for a `label` — the first-DNS-label prefix before `-<sandboxId>`:
// `preview-<panel>` for panel dev servers, `port-<slot>` for forwarded ports. Called BEFORE the hostname is
// handed to a browser, so it resolves by the time the iframe/tab loads — an early NXDOMAIN would get
// negative-cached for the zone's SOA TTL. Own-Cloudflare sandboxes get an `{ok:true}` no-op from the platform
// (their `*.<zone>` wildcard already serves the hostname). Never rejects: a panel must start even when the
// platform is unreachable — the warn log is the operator's signal, and the next start retries.
// Ensure a route for every repo already in the workspace — the boot-time self-heal for repos whose creation
// happened while the platform was unreachable. Cloudflare keeps routes across daemon restarts, so this is
// usually all no-ops on the platform side; a hostname must exist LONG before a browser first resolves it (an
// early NXDOMAIN gets negative-cached for the zone's SOA TTL), which is why routes mint at repo-appearance,
// not panel start.
export const ensureAllPreviewRoutes = async (services: Services): Promise<void> => {
    const discovered = await discoverPanels(services.workspace);
    const keys = discovered.map(({ repo }) => panelKey(repo)).filter((key): key is string => key !== undefined);
    await Promise.all(keys.map((key) => services.ensurePreviewRoute(previewLabel(key))));
};

export const createPreviewRouteEnsurer = (config: Config, logger: Logger): ((label: string) => Promise<void>) => {
    // Labels already routed this boot — bounds Cloudflare traffic to one ensure per label per daemon lifetime
    // (the platform side is idempotent, so a daemon restart re-ensuring is cheap).
    const ensured = new Set<string>();
    // Serialize the platform calls: the ingress update is a read-modify-write of the whole tunnel config, so
    // two concurrent ensures could drop each other's route.
    // ponytail: per-daemon serialization only — a multi-replica platform race self-heals on the next start.
    let tail = Promise.resolve();
    return (label) => {
        if (config.platform.url === "" || config.connectToken === "" || ensured.has(label)) {
            return Promise.resolve();
        }
        tail = tail.then(async () => {
            if (ensured.has(label)) {
                return;
            }
            try {
                const { status } = await postToPlatform(config, "/sandbox/preview-route", { label });
                if (status < 200 || status >= 300) {
                    logger.warn({ label, status }, "preview route not minted — the preview hostname may not resolve");
                    return;
                }
                ensured.add(label);
            } catch (error) {
                logger.warn({ err: error, label }, "preview route request failed — the preview hostname may not resolve");
            }
        });
        return tail;
    };
};
