import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, contributionCard } from "@intentic/capability-catalog";
import { contributionRegistry } from "./contributions.js";
import type { ExtensionHost } from "../extensions/installed-extensions.js";

/* EVERY CARD THIS SANDBOX CAN CONNECT, the static catalog merged with the enabled extensions' contributed cards. */
export const connectableCards = async (host: ExtensionHost): Promise<CapabilityCatalogEntry[]> => {
    const contributed = await contributionRegistry(host);
    const cards: CapabilityCatalogEntry[] = [...CAPABILITY_CATALOG];
    const seen = new Set(cards.map((card) => card.id));
    for (const { spec } of contributed.values()) {
        const card = contributionCard(spec);
        if (!seen.has(card.id)) {
            seen.add(card.id);
            cards.push(card);
        }
    }
    return cards;
};
