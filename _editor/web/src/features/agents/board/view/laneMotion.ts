import { nextTick, onBeforeUpdate, onUpdated, type Ref } from "vue";
import type { FleetLane } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";

// Where the cards stand on screen and how they move between renders: a card changing lanes flies from where it stood,
// with elevation and a landing pulse, and the cards it left close ranks. Measured across the render that moved them
// (FLIP), the only moment that knows both places.

// Where a card stands: its box on screen and the lane it is in.
export interface CardPlace {
    readonly rect: Pick<DOMRect, `left` | `top`>;
    readonly lane: FleetLane;
}

export type CardMove = { readonly kind: `flight`; readonly dx: number; readonly dy: number } | { readonly kind: `reflow`; readonly dy: number };

// How a card moved across one render: a flight when it changed lanes, a reflow within one while no filter is on, and
// nothing when it stayed put. Offsets run from where it is now back to where it was (px).
export const cardMove = (before: CardPlace, after: CardPlace, filtering: boolean): CardMove | undefined => {
    const dx = before.rect.left - after.rect.left;
    const dy = before.rect.top - after.rect.top;
    if (dx === 0 && dy === 0) {
        return undefined;
    }
    if (before.lane !== after.lane) {
        return { kind: `flight`, dx, dy };
    }
    return filtering ? undefined : { kind: `reflow`, dy };
};

export const laneHolding = (lanes: Record<FleetLane, readonly FleetAgent[]>, id: string): FleetLane | undefined => {
    if (lanes.attention.some((agent) => agent.id === id)) {
        return `attention`;
    }
    if (lanes.active.some((agent) => agent.id === id)) {
        return `active`;
    }
    if (lanes.finished.some((agent) => agent.id === id)) {
        return `finished`;
    }
    return undefined;
};

const laneOfEl = (el: HTMLElement): FleetLane | undefined => el.closest<HTMLElement>(`section[data-lane]`)?.dataset[`lane`] as FleetLane | undefined;

const flyCard = (el: HTMLElement, dx: number, dy: number): void => {
    const animation = el.animate(
        [
            {
                transform: `translate3d(${dx}px, ${dy}px, 0) scale(1.02)`,
                boxShadow: `0 12px 28px -4px rgba(0, 0, 0, 0.28), 0 8px 10px -4px rgba(0, 0, 0, 0.2)`,
                zIndex: 40,
            },
            {
                transform: `translate3d(0, 0, 0) scale(1)`,
                boxShadow: `none`,
                zIndex: 40,
            },
        ],
        {
            duration: 260,
            easing: `cubic-bezier(0.2, 0, 0, 1)`,
        },
    );
    animation.onfinish = () => {
        el.animate(
            [
                { outline: `2px solid color-mix(in srgb, var(--color-primary-500) 70%, transparent)`, outlineOffset: `1px` },
                { outline: `2px solid transparent`, outlineOffset: `1px` },
            ],
            {
                duration: 600,
                easing: `cubic-bezier(0.2, 0, 0, 1)`,
            },
        );
    };
};

const closeRanks = (el: HTMLElement, dy: number): void => {
    el.animate([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: `translate3d(0, 0, 0)` }], {
        duration: 220,
        easing: `cubic-bezier(0.2, 0, 0, 1)`,
    });
};

export interface MotionHost {
    // The board's lanes, where each card is about to stand.
    readonly lanes: Readonly<Ref<Record<FleetLane, FleetAgent[]>>>;
    readonly filtering: Readonly<Ref<boolean>>;
    // The card in the pointer's hand (useAgentDrag) moves with the ghost, not here.
    readonly drag: { readonly draggedId: Readonly<Ref<string | undefined>>; readonly dragging: Readonly<Ref<boolean>> };
}

// The cards' elements for the component that draws them: registered through each card's `:ref`, snapshotted before
// every render and animated after it; called from that component's setup, since it hooks its renders.
export const useLaneMotion = (host: MotionHost) => {
    const cardEls = new Map<string, HTMLElement>();
    const before = new Map<string, CardPlace>();
    // AgentCard is a component, so the ref is its instance, not an element; `$el` is its root div.
    const setCardEl = (id: string, el: unknown): void => {
        const root = (el as { $el?: unknown } | null)?.$el;
        if (root instanceof HTMLElement) {
            cardEls.set(id, root);
        } else {
            const existing = cardEls.get(id);
            if (existing && !existing.isConnected) {
                cardEls.delete(id);
            }
        }
    };
    // Moving between lanes bypasses the CSS transition, so the card flies from its previous coordinates without ghosting.
    const isMovingLane = (id: string): boolean => {
        const el = cardEls.get(id);
        if (!el || !el.isConnected) {
            return false;
        }
        const prevLane = laneOfEl(el);
        const nextLane = laneHolding(host.lanes.value, id);
        return prevLane !== undefined && nextLane !== undefined && prevLane !== nextLane;
    };
    onBeforeUpdate(() => {
        before.clear();
        for (const [id, el] of cardEls) {
            if (!el.isConnected) {
                cardEls.delete(id);
                continue;
            }
            const currentLane = laneOfEl(el);
            if (!currentLane) {
                continue;
            }
            before.set(id, { rect: el.getBoundingClientRect(), lane: currentLane });
            const nextLane = laneHolding(host.lanes.value, id);
            if (nextLane !== undefined && nextLane !== currentLane) {
                el.style.opacity = `0`;
                el.style.pointerEvents = `none`;
            }
        }
    });
    const canAnimate = (id: string, el: HTMLElement): boolean =>
        el.isConnected && !(host.drag.draggedId.value === id && host.drag.dragging.value) && typeof el.animate === `function`;
    const animate = (id: string, el: HTMLElement): void => {
        if (!canAnimate(id, el)) {
            return;
        }
        const prev = before.get(id);
        const lane = laneOfEl(el);
        if (!prev || !lane) {
            return;
        }
        const move = cardMove(prev, { rect: el.getBoundingClientRect(), lane }, host.filtering.value);
        if (move?.kind === `flight`) {
            flyCard(el, move.dx, move.dy);
        }
        if (move?.kind === `reflow`) {
            closeRanks(el, move.dy);
        }
    };
    onUpdated(() => {
        const prefersReducedMotion = typeof window !== `undefined` && window.matchMedia?.(`(prefers-reduced-motion: reduce)`).matches;
        if (!prefersReducedMotion) {
            for (const [id, el] of cardEls) {
                animate(id, el);
            }
        }
        before.clear();
    });
    // Awaited, since the card may not be drawn on the tick it is asked for (the window pins it, the focus flow uncovers
    // it); `nearest` leaves an already-visible card alone.
    const revealCard = async (id: string): Promise<void> => {
        await nextTick();
        cardEls.get(id)?.scrollIntoView({ block: `nearest` });
    };
    return { setCardEl, isMovingLane, revealCard };
};
