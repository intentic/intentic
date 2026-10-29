import { onBeforeUnmount, type Ref, ref, watch } from "vue";
import { LANE_FLOOR, LANE_WALL, type LaneBox, type LaneSeat, laneSeat, marksChanged } from "./laneSeat";

/* Keeps the lane's corner measured while it has something to show (laneSeat.ts). Nothing is observed while the lane is
   empty: the watchers come up with the first card and go with the last. */
export const useLaneSeat = (lane: Ref<HTMLElement | undefined>, active: Ref<boolean>): Ref<LaneSeat | undefined> => {
    const seat = ref<LaneSeat>();
    let frame = 0;
    let sizes: ResizeObserver | undefined;
    let arrivals: MutationObserver | undefined;
    const watched = new Set<Element>();

    const follow = (elements: readonly Element[]): void => {
        for (const element of watched) {
            if (!elements.includes(element)) {
                sizes?.unobserve(element);
                watched.delete(element);
            }
        }
        for (const element of elements) {
            if (!watched.has(element)) {
                sizes?.observe(element);
                watched.add(element);
            }
        }
    };

    const measure = (): void => {
        frame = 0;
        const walls = [...document.querySelectorAll(LANE_WALL)];
        // A floor keeps its box where the reader cannot see it: a column kept mounted `invisible`, the quick bar's composer
        // faded out under its pill. Only one on screen holds the lane up.
        const floors = [...document.querySelectorAll(LANE_FLOOR)].filter(
            (floor) => floor.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true,
        );
        follow([...walls, ...floors, ...(lane.value === undefined ? [] : [lane.value])]);
        const box = (element: Element): LaneBox => element.getBoundingClientRect();
        const next = laneSeat(walls.map(box), floors.map(box), { width: window.innerWidth, height: window.innerHeight }, lane.value?.offsetWidth ?? 0);
        if (next.left !== seat.value?.left || next.bottom !== seat.value?.bottom) {
            seat.value = next;
        }
    };

    // One measurement per frame at most, after anything that can have moved the corner: the window, a wall or floor
    // resizing, the lane itself widening for a wider card.
    const schedule = (): void => {
        if (frame === 0) {
            frame = requestAnimationFrame(measure);
        }
    };

    // A view's floor arrives through a dynamic import, after every event above has passed: measured on the spot, at the
    // microtask after the patch that inserted it, so no frame paints a card over it.
    const onArrivals = (records: MutationRecord[]): void => {
        if (marksChanged(records)) {
            cancelAnimationFrame(frame);
            measure();
        }
    };

    const stop = (): void => {
        cancelAnimationFrame(frame);
        frame = 0;
        sizes?.disconnect();
        arrivals?.disconnect();
        sizes = undefined;
        arrivals = undefined;
        watched.clear();
        window.removeEventListener(`resize`, schedule);
    };

    // `post`: the first card is in the DOM, so the lane's width is real, and the corner is set before it is painted.
    watch(
        active,
        (on) => {
            if (!on) {
                stop();
                return;
            }
            if (sizes === undefined) {
                sizes = new ResizeObserver(schedule);
                arrivals = new MutationObserver(onArrivals);
                arrivals.observe(document.body, { childList: true, subtree: true });
                window.addEventListener(`resize`, schedule);
            }
            measure();
        },
        { immediate: true, flush: `post` },
    );

    onBeforeUnmount(stop);
    return seat;
};
