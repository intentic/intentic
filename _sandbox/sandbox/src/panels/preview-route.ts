import { portLabel, previewLabel, publicLabel } from "@intentic/sandbox-contract";
import { portSlotsFromToken, publicSlotFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverPanels, panelKey } from "./panels.js";

const exec = promisify(execFile);

/* THE SANDBOX'S OWN PUBLIC NAMES, panel dev servers (`preview-<panel>`), forwarded ports (`port-<slot>`)
 * and the outbox (`public-<slot>`), all served by the preview proxy under the tunnel hub's ONE wildcard.
 *
 * This used to ask the PLATFORM to mint a DNS record per label (its /sandbox/preview-route relay, since
 * deleted): the fabric was Cloudflare's, only the platform held a token for the zone, and every name cost the
 * zone a record against its quota. Under the self-hosted hub a name is a row on the controller rather than
 * DNS, and the box holds its OWN account token, so the sandbox attaches its names itself and the platform is
 * off the naming path entirely. One less thing a compromised platform could do to a sandbox.
 *
 * Called BEFORE a hostname is handed to a browser, and never rejects: a panel must start even when the hub is
 * unreachable, the warn log is the operator's signal and the next ensure retries.
 */
export const ensureAllPreviewRoutes = async (services: Services): Promise<void> => {
    const discovered = await discoverPanels(services.workspace);
    const keys = discovered.map(({ repo }) => panelKey(repo)).filter((key): key is string => key !== undefined);
    const slots = portSlotsFromToken(services.config.connectToken);
    const outbox = publicLabel(publicSlotFromToken(services.config.connectToken));
    await services.ensurePreviewRoutes([...keys.map(previewLabel), ...slots.map(portLabel), outbox]);
};

export const createPreviewRouteEnsurer = (config: Config, logger: Logger): ((labels: readonly string[]) => Promise<void>) => {
    // Names already shared this boot, one share per label per daemon lifetime. The hub is idempotent about a
    // name it already knows, so a restart re-sharing is cheap; this just avoids spawning the agent for nothing.
    const ensured = new Set<string>();
    // Serialized: each share is an agent invocation, and a burst of panel starts would otherwise race a dozen
    // processes at the controller for no gain.
    let tail = Promise.resolve();
    return (labels) => {
        // No grant ⇒ nothing to share under: an attached sandbox (its owner's own domain) serves its previews
        // however that domain does, and a sandbox before its first claim has no account yet.
        if (config.zrok.token === "") {
            return Promise.resolve();
        }
        tail = tail.then(async () => {
            const missing = labels.filter((label) => !ensured.has(label));
            if (missing.length === 0) {
                return;
            }
            const target = `http://127.0.0.1:${config.preview.port}`;
            const namespace = config.zrok.namespace === "" ? "public" : config.zrok.namespace;
            for (const label of missing) {
                try {
                    /* Two calls, because the hub separates the NAME from the share that answers on it: the name
                     * is claimed in the namespace first (a hostname reserved to this account), then a public
                     * share is bound to it, pointed at the preview proxy, which already routes by Host header,
                     * so every preview name lands on the same port and the daemon's existing dispatch does the
                     * rest. Both calls return immediately: the in-box agent (started by the entrypoint) is what
                     * actually holds the share, so nothing here has to stay resident. A name that exists and a
                     * share already bound to it both answer 409, which is this loop's idea of success. */
                    // oxlint-disable-next-line eslint/no-await-in-loop -- serialized on purpose (see above)
                    await exec("zrok2", ["create", "name", label, "--namespace-token", namespace]).catch((error: unknown) => {
                        if (!/already|exists|conflict/i.test(error instanceof Error ? error.message : String(error))) {
                            throw error;
                        }
                    });
                    // oxlint-disable-next-line eslint/no-await-in-loop -- serialized on purpose (see above)
                    await exec("zrok2", ["share", "public", target, "--backend-mode", "proxy", "--name-selection", `${namespace}:${label}`]);
                    ensured.add(label);
                } catch (error) {
                    // A name this account already serves is success, not a failure to report.
                    const message = error instanceof Error ? error.message : String(error);
                    if (/already|exists|conflict|in use/i.test(message)) {
                        ensured.add(label);
                        continue;
                    }
                    logger.warn({ err: error, label }, "preview name not shared, this preview hostname may not resolve");
                }
            }
        });
        return tail;
    };
};
