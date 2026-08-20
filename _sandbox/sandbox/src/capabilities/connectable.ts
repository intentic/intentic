import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, contributionCard } from "@intentic-app/capability-catalog";
import { contributionRegistry } from "./contributions.js";
import type { ExtensionHost } from "../extensions/installed-extensions.js";

/* EVERY CARD THIS SANDBOX CAN CONNECT, the static catalog merged with the enabled extensions' contributed
 * cards, exactly the set the web's "+" grid renders (Capabilities.vue does the same merge from GET
 * /extensions). The daemon needs its own copy of the merge for the capability ask gate: an agent's ask is
 * validated against it, the card raised in chat takes its title from it, and the `capabilities` CLI's
 * discovery lists it, all of which must answer synchronously, without a browser open.
 *
 * Static cards lead and the first declaration of an id wins, so an extension cannot shadow a first-party
 * card under the same name, the ask names a bare card id, and what it resolves to must not depend on which
 * extensions happen to be installed. */
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
