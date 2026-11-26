import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import { listenerOwnership } from "../listener/listener-state.js";

// (2026-11-26) Which automations' public doors take a door key: kept apart from the door itself (public-door.routes.ts),
// since saving and listing an automation ask it too.

/**
 * The listener providers whose automations get a door key (minted and shown as an `ingestKey`, rotated like the bug
 * intake's): those whose owning extension declares an automation-scoped public route that takes one.
 */
export const keyedDoorProviders = async (services: ExtensionHost): Promise<ReadonlySet<string>> => {
    const extensions = await cachedEnabledExtensions(services);
    const owners = (await listenerOwnership(services)).owners;
    const keyed = new Set<string>();
    for (const extension of extensions) {
        const contributes = extension.manifest.contributes;
        const provider = contributes?.listener?.provider;
        if (provider !== undefined && owners.get(provider) === extension.id && (contributes?.publicRoutes ?? []).some((route) => route.key === true)) {
            keyed.add(provider);
        }
    }
    return keyed;
};
