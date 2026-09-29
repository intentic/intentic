import { onScopeDispose, watch, type Ref } from "vue";

// On a phone, back is the dismiss gesture: without this an open sheet is invisible to history and back leaves the
// page instead of closing it. An open overlay holds one history entry; back pops that entry and closes only it.
// The entry carries vue-router's own state shape so the router keeps counting positions across it.

const TICKET = `overlayDismiss`;
let issued = 0;

// The traversal a closing overlay started to give its entry back, until it lands. A pick that closes a sheet navigates
// in the same tick, and a route pushed before this lands would be the entry the traversal steps back from: the pick
// undone within milliseconds. So the router waits for it (overlayBackSettled).
let traversing: Promise<void> | undefined;

// A same-document traversal lands within a frame or two; this only bounds a popstate that never comes.
const TRAVERSAL_MS = 500;

// Steps off this overlay's entry without the router or any other open overlay hearing it: the entry had the page's
// own URL, so for them nothing moved, and hearing it the router would start a navigation of its own that cancels the
// pick's, while an overlay underneath would close too.
const retreat = (): void => {
    let landed: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
        landed = resolve;
    });
    const finish = (): void => {
        clearTimeout(timer);
        removeEventListener(`popstate`, swallow, true);
        if (traversing === settled) {
            traversing = undefined;
        }
        landed();
    };
    // Capture on the window runs before the router's own listener there, so stopping it here keeps it from them all.
    function swallow(event: PopStateEvent): void {
        event.stopImmediatePropagation();
        finish();
    }
    const timer = setTimeout(finish, TRAVERSAL_MS);
    addEventListener(`popstate`, swallow, true);
    traversing = settled;
    history.back();
};

/** Resolves once a closing overlay's own back traversal has landed; undefined when none is under way. For a router
 *  guard, so a navigation started by a pick in a sheet is pushed only after the sheet's entry is gone. */
export const overlayBackSettled = (): Promise<void> | undefined => traversing;

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
            retreat();
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
