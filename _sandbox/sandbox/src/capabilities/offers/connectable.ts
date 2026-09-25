import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, contributionEntry } from "@intentic/capability-catalog";
import { contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";

/* EVERY CARD THIS SANDBOX CAN CONNECT, the static catalog merged with the enabled extensions' contributed entries. */
export const connectableEntries = async (host: ExtensionHost): Promise<CapabilityCatalogEntry[]> => {
    const contributed = await contributionRegistry(host);
    const entries: CapabilityCatalogEntry[] = [...CAPABILITY_CATALOG];
    const seen = new Set(entries.map((entry) => entry.id));
    for (const { spec } of contributed.values()) {
        const entry = contributionEntry(spec);
        if (!seen.has(entry.id)) {
            seen.add(entry.id);
            entries.push(entry);
        }
    }
    return entries;
};
