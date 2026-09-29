import { computed, type Ref, ref } from "vue";
import { agentDisplayTitle } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";

// What archiving one card from the board does when children ride under it (childFold): it asks first, naming how many
// go with it. One tap on a phone archived an agent and its seven children with nothing said, and the list reflowed
// under the next tap. A card with no children is archived at once, as it always was: nothing is lost by it, and the
// receipt's Undo brings it back. On a touch screen that receipt is drawn for a single card too, since the card leaving
// is all a reader sees there, and a reflowed list hides even that.

export interface FamilyArchiveHost {
    // The fleet store's archive; a receipt with Undo is drawn for several ids, or for one when `receipt` says so.
    readonly archive: (ids?: readonly string[], options?: { readonly receipt?: boolean }) => Promise<void>;
    // The card's own id and those of every child riding under it (boardTrays.familyIds).
    readonly familyIds: (card: FleetAgent) => string[];
    readonly agentById: (id: string) => FleetAgent | undefined;
    // A touch screen, where a single archive also gets its receipt.
    readonly coarse: Readonly<Ref<boolean>>;
}

// The archive a card asked for, held while the dialog asks.
export interface PendingFamilyArchive {
    readonly ids: readonly string[];
    readonly title: string;
    readonly children: number;
}

export const useFamilyArchive = (host: FamilyArchiveHost) => {
    const pending = ref<PendingFamilyArchive | undefined>(undefined);
    const run = (ids: readonly string[]): Promise<void> => host.archive(ids, { receipt: host.coarse.value });
    // One card's archive, from its own icon or its menu row: asked about when it takes children along.
    const request = (card: FleetAgent): Promise<void> => {
        const ids = host.familyIds(card);
        if (ids.length > 1) {
            pending.value = { ids, title: agentDisplayTitle(card), children: ids.length - 1 };
            return Promise.resolve();
        }
        return run(ids);
    };
    // The menu names ids, not cards; with no ids it is the lane's Clear, which already says what it archives.
    const requestIds = (ids?: readonly string[]): Promise<void> => {
        if (ids === undefined) {
            return host.archive(undefined);
        }
        const card = ids.length === 1 ? host.agentById(ids[0] ?? ``) : undefined;
        if (card !== undefined) {
            return request(card);
        }
        const everyone = ids.flatMap((id) => {
            const named = host.agentById(id);
            return named === undefined ? [id] : host.familyIds(named);
        });
        return run([...new Set(everyone)]);
    };
    const confirm = (): Promise<void> => {
        const held = pending.value;
        pending.value = undefined;
        return held === undefined ? Promise.resolve() : run(held.ids);
    };
    const cancel = (): void => {
        pending.value = undefined;
    };
    const asking = computed(() => pending.value !== undefined);
    return { pending, asking, request, requestIds, confirm, cancel };
};
