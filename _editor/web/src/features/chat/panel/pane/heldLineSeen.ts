import { nextTick, onScopeDispose, ref, type Ref, watch } from "vue";

// Whether the held message's own line (ChatHeldMessages: "Not sent · why", and its press) is on screen: inside the
// transcript's scroller and clear of the composer stuck over its foot. The bar above the composer (ChatWaitingBar)
// repeats a memory hold only while it is not, since both on screen at once read as two things waiting, and the line
// is the fuller of the two (the figures, the raise, a press that leaves bookings on their time).

/** Marks the held line's press row, so the bar can find it in its own pane. */
export const HELD_PRESS_ATTR = `data-held-press`;

/**
 * Seen or not, kept current while `key` names a hold (re-read whenever it changes, the line mounting on the next tick).
 * A pane where the line cannot be found, or a window with no layout to measure, counts it unseen: the bar then says it,
 * which is the safe way to be wrong.
 */
export const useHeldLineSeen = (
    anchor: Readonly<Ref<HTMLElement | null | undefined>>,
    key: Readonly<Ref<string | undefined>>,
): Readonly<Ref<boolean>> => {
    const seen = ref(false);
    let release: (() => void) | undefined;

    const follow = (): void => {
        release?.();
        release = undefined;
        seen.value = false;
        const scroller = anchor.value?.closest<HTMLElement>(`.chat-scroller`);
        const line = scroller?.querySelector<HTMLElement>(`[${HELD_PRESS_ATTR}]`);
        if (key.value === undefined || scroller === null || scroller === undefined || line === null || line === undefined) {
            return;
        }
        const footer = scroller.querySelector<HTMLElement>(`.chat-footer`);
        let frame = 0;
        const measure = (): void => {
            frame = 0;
            const view = scroller.getBoundingClientRect();
            const row = line.getBoundingClientRect();
            // An unlaid line (display none, a test window) measures zero high: not seen.
            const floor = Math.min(view.bottom, footer?.getBoundingClientRect().top ?? view.bottom);
            seen.value = row.height > 0 && row.top >= view.top && row.bottom <= floor;
        };
        const soon = (): void => {
            frame ||= requestAnimationFrame(measure);
        };
        measure();
        scroller.addEventListener(`scroll`, soon, { passive: true });
        // The composer growing or the pane resizing moves the line without a scroll.
        const sizes = typeof ResizeObserver === `undefined` ? undefined : new ResizeObserver(soon);
        sizes?.observe(scroller);
        if (footer !== null) {
            sizes?.observe(footer);
        }
        release = () => {
            scroller.removeEventListener(`scroll`, soon);
            sizes?.disconnect();
            if (frame !== 0) {
                cancelAnimationFrame(frame);
            }
        };
    };

    watch([key, anchor], () => void nextTick(follow), { immediate: true });
    onScopeDispose(() => release?.());
    return seen;
};
