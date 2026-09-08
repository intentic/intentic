import type { Services } from "../composition.js";
import { providerPackWants } from "../agent/providers/provider-registry.js";
import { translatorWanted } from "../agent/providers/translator.js";
import { packFragment } from "./packs.js";

// Packs a connected provider needs, the provider-side counterpart to capabilityFragments; each provider module declares
// its own `packs`. translator stays here since no single provider owns it. Connected state is read from disk, never the
// live helper: on a core image the helper is absent, so a live probe would always say unconnected.
export const providerPackFragments = async (services: Services): Promise<string[]> => {
    const [wants, translator] = await Promise.all([providerPackWants(services), translatorWanted(services)]);
    const names = [...wants, ...(translator ? ["translator"] : [])];
    const fragments = await Promise.all(names.map((name) => packFragment(name)));
    return fragments.filter((fragment): fragment is string => fragment !== undefined);
};
