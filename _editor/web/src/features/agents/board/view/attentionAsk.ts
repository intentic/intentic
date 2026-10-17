import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { nextTick, type Ref, watch } from "vue";
import { attentionAsk } from "../../../../models/fleet/board/attentionOutside";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// The Agents tile pressed while the board is already open (attentionOutside.askForAttention): it has widened the project
// choice; here the board does the rest of what the press means. Whatever else hides cards (a filter in the field, the
// archive) is put away, the Attention lane is scrolled to, its first row is marked, and a lane with exactly one row opens
// it, since "one thing needs you" is answered by the thing.

export interface AttentionAskHost {
    readonly board: Readonly<Ref<HTMLElement | undefined>>;
    readonly filtering: Readonly<Ref<boolean>>;
    readonly clearFilter: () => void;
    readonly inArchive: Readonly<Ref<boolean>>;
    readonly leaveArchive: () => void;
    // The rows the Attention lane draws now: cards, runs and held wakes.
    readonly rows: () => { readonly cards: readonly FleetAgent[]; readonly runs: readonly WorkflowRun[]; readonly wakes: number };
    readonly openCard: (agent: FleetAgent) => void;
    readonly openRun: (run: WorkflowRun) => void;
}

const MARK_MS = 1_600;

// A ring that fades, drawn on the row itself: it asks nothing of the row's markup, and a row that re-renders keeps its own.
const mark = (row: HTMLElement): void => {
    if (!(`animate` in row)) {
        return;
    }
    row.animate(
        [{ boxShadow: `0 0 0 3px var(--color-primary-500, currentColor)` }, { boxShadow: `0 0 0 3px transparent` }],
        { duration: MARK_MS, easing: `ease-out` },
    );
};

export const useAttentionAsk = (host: AttentionAskHost): void => {
    watch(attentionAsk, async () => {
        if (host.filtering.value) {
            host.clearFilter();
        }
        if (host.inArchive.value) {
            host.leaveArchive();
        }
        // Twice: the widened scope re-lays the lanes, and the cards then arrive a frame after.
        await nextTick();
        await nextTick();
        const lane = host.board.value?.querySelector<HTMLElement>(`[data-lane="attention"]`);
        lane?.scrollIntoView({ block: `start`, behavior: `smooth` });
        const first = lane?.querySelector<HTMLElement>(`[data-reveal]`);
        // A card is the unit with its children under it; the ring belongs on the card.
        const row = first?.matches(`[data-fold-unit]`) === true ? first.firstElementChild : first;
        if (row instanceof HTMLElement) {
            mark(row);
        }
        const { cards, runs, wakes } = host.rows();
        if (cards.length + runs.length + wakes !== 1) {
            return;
        }
        const [card] = cards;
        const [run] = runs;
        if (card !== undefined) {
            host.openCard(card);
        } else if (run !== undefined) {
            host.openRun(run);
        }
    });
};
