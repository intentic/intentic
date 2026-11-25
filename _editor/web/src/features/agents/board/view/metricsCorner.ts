import { onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";
import type { FleetLane } from "../../../../models/agent-status/agentStatus-lanes";

// THE BOARD'S BOTTOM-LEFT IS THE SANDBOX'S CORNER, as its bottom-right is Usage left's (cornerFit.ts): the geek metrics
// (BoardMetrics.vue `corner`) stand at the foot of the board's first column, whichever lane ends it (boardGrid.ts
// `foot`). Until 2026-11-24 they were in the board's header, where every warning added a group to a line that had no room
// for it, and the figures worth acting on were cut off first.
//
// THE LANE NEVER GIVES WAY TO IT. Finished hides the cards Usage left leaves no room for behind "N earlier", which is
// fine for work that is done; the first column holds Attention, whose questions and failures must never hide behind a
// count. So here the corner gives way instead: it stands open (a row a gauge) while the column's cards and it fit on the
// board's first screen, and folds to one row once they do not. Memory running out is what fails agents into Attention,
// so the folded row is often the one standing while it matters, and it says the worst of it (SandboxMetricsSummary).
//
// It sticks to the board's foot (AgentsView), so it stays in sight however far the board is scrolled; the cards of a
// long column pass under the folded row and all come out above it at the end of the scroll, as under any sticky footer.
//
// The fit is read off the drawn board, never estimated, by a mark drawn right after the column's last card: where that
// mark stands against the first screen's foot, less the open card's height (its own once it has been drawn open), says
// whether it fits. The fold changes nothing above the mark, so the reading never feeds back into itself.

export interface MetricsCornerHost {
    readonly scroller: Readonly<Ref<HTMLElement | undefined>>;
    readonly grid: Readonly<Ref<HTMLElement | undefined>>;
    // The lane the corner stands in, or none where it is not drawn.
    readonly foot: () => FleetLane | undefined;
}

// The gap the board draws between the column's last card and the corner (AgentsView's `h-6`).
const GAP_PX = 24;
// The open card's height until it has been drawn open once: a heading and three gauges.
const OPEN_GUESS_PX = 150;

export const useMetricsCorner = ({ scroller, grid, foot }: MetricsCornerHost) => {
    const fold = ref(false);
    let openPx = OPEN_GUESS_PX;
    // Queried, not held by template refs: the mark moves from lane to lane as the layout changes, and a ref released by
    // the lane it left could clear the one the lane it went to had just set.
    const read = (): void => {
        const port = scroller.value;
        const mark = grid.value?.querySelector<HTMLElement>(`[data-metrics-mark]`);
        if (foot() === undefined || port === undefined || mark === null || mark === undefined) {
            return;
        }
        const card = grid.value?.querySelector<HTMLElement>(`[data-metrics-corner]`);
        if (!fold.value && card !== null && card !== undefined && card.offsetHeight > 0) {
            openPx = card.offsetHeight;
        }
        const top = mark.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop;
        const padding = grid.value === undefined ? 0 : Number.parseFloat(getComputedStyle(grid.value).paddingBottom) || 0;
        fold.value = top + GAP_PX + openPx > port.clientHeight - padding;
    };
    // The board resized, a card arrived, left or reworded, or one finished sliding: each read before the frame paints.
    const resized = new ResizeObserver(read);
    const changed = new MutationObserver(read);
    watch(
        grid,
        (lanes, was) => {
            was?.removeEventListener(`transitionend`, read);
            changed.disconnect();
            if (lanes !== undefined) {
                resized.observe(lanes);
                changed.observe(lanes, { childList: true, subtree: true, characterData: true });
                lanes.addEventListener(`transitionend`, read);
            }
        },
        { immediate: true },
    );
    watch(
        scroller,
        (port) => {
            if (port !== undefined) {
                resized.observe(port);
            }
        },
        { immediate: true },
    );
    watch(foot, read, { flush: `post` });
    onMounted(read);
    onBeforeUnmount(() => {
        grid.value?.removeEventListener(`transitionend`, read);
        resized.disconnect();
        changed.disconnect();
    });
    return { fold };
};
