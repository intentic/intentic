import { computed, type ComputedRef } from "vue";
import { useAreas } from "../../../models/sandbox/access/useAreas";
import { useAccessProfiles } from "../../../models/sandbox/access/useAccessProfiles";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import type { Tip } from "@intentic/ui";
import { lensRoleId, reachOf, reachTip, type RoleAccess } from "./roleReach";

// What the "viewing as" lens reads a card's fence from: the access profiles listing it and the areas they name. A reader
// who may not list profiles sees every card unfenced, which only ever dims less, never blocks anything.
export const useRoleAccess = (): ComputedRef<RoleAccess> => {
    const { profiles } = useAccessProfiles();
    // Read only while a card is read as: the tree draws for everyone, and only the lens needs the areas.
    const { areas } = useAreas(() => lensRoleId.value !== undefined);
    return computed(() => ({ profiles: profiles.value, areas: areas.value }));
};

// The lens's folder list, as the tooltip on the lit funnel says it, for the card the lens reads as (none: no tip).
export const useLensTip = (card: ComputedRef<Role | undefined>): ComputedRef<Tip | undefined> => {
    const access = useRoleAccess();
    return computed(() => (card.value === undefined ? undefined : reachTip(card.value.label ?? card.value.id, reachOf(card.value, access.value))));
};
