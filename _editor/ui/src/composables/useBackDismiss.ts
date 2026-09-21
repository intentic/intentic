import { onScopeDispose, watch, type Ref } from "vue";

// On a phone, back is the dismiss gesture: without this an open sheet is invisible to history and back leaves the
// page instead of closing it. An open overlay holds one history entry; back pops that entry and closes only it.
// The entry carries vue-router's own state shape so the router keeps counting positions across it.

const TICKET = `overlayDismiss`;
let issued = 0;

export const useBackDismiss = (open: Ref<boolean>): void => {
    let ticket: number | undefined;

    const release = (): void => {
        removeEventListener(`popstate`, onPop);
        ticket = undefined;
    };

    function onPop(): void {
        if (ticket === undefined) {
            return;
        }
        release();
        open.value = false;
    }

    const claim = (): void => {
        ticket = ++issued;
        const state = (history.state ?? {}) as Record<string, unknown>;
        const position = typeof state[`position`] === `number` ? state[`position`] + 1 : 0;
        history.pushState({ ...state, position, [TICKET]: ticket }, ``);
        addEventListener(`popstate`, onPop);
    };

    // Closed by a choice rather than by back: the entry is spent here so one back press still goes up a level.
    // Skipped once a navigation has stacked its own entry over ours, which back has to undo first.
    const spend = (): void => {
        const mine = (history.state as Record<string, unknown> | null)?.[TICKET] === ticket;
        release();
        if (mine) {
            history.back();
        }
    };

    watch(open, (isOpen) => {
        if (isOpen && ticket === undefined) {
            claim();
        } else if (!isOpen && ticket !== undefined) {
            spend();
        }
    });

    onScopeDispose(() => {
        if (ticket !== undefined) {
            spend();
        }
    });
};
