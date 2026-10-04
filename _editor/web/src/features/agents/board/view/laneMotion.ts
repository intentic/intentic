import { nextTick, onBeforeUpdate, onMounted, onUpdated, type Ref } from "vue";
import type { FleetLane } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { lessMotion, slideFrom, stopSlide } from "@intentic/ui/motion";

// Where the cards stand on screen and how they move between renders: a card changing lanes flies from where it stood,
// with elevation and a landing pulse, and the cards it left close ranks, as do the cards below a tray that opened or
// shut (@intentic/ui/motion, fold.ts). Measured across the render that moved them (FLIP), the only moment that knows both places.

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

// Which cards stand in which lane, in order: the only thing a render can change that moves a card between places. The
// board re-renders about once a second per running turn (a clock, a status line), and measuring every card twice around
// each of those renders forced two full-board layouts for motion that could not exist.
export const laneOrder = (lanes: Record<FleetLane, readonly FleetAgent[]>): string =>
    [lanes.attention, lanes.active, lanes.finished].map((lane) => lane.map((agent) => agent.id).join(`,`)).join(`|`);

const laneOfEl = (el: HTMLElement): FleetLane | undefined => el.closest<HTMLElement>(`section[data-lane]`)?.dataset[`lane`] as FleetLane | undefined;

// The flight itself is `transform` alone, so the compositor carries it through whatever the landing render costs the
// main thread; the lift (shadow, stacking) and the landing pulse are paint, on effects of their own, and the shadow has
// only a first keyframe, so it eases into the card's own at rest rather than snapping to none and back.
const flyCard = (el: HTMLElement, dx: number, dy: number): void => {
    const timing = { duration: 260, easing: `cubic-bezier(0.2, 0, 0, 1)` };
    const animation = el.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0) scale(1.02)` }, { transform: `translate3d(0, 0, 0) scale(1)` }],
        timing,
    );
    el.animate([{ boxShadow: `0 12px 28px -4px rgba(0, 0, 0, 0.28), 0 8px 10px -4px rgba(0, 0, 0, 0.2)`, zIndex: 40 }, { zIndex: 40 }], timing);
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

// A card and the tray riding under it move as one unit (AgentsView's `data-fold-unit` wrapper, the card first in it), so
// a card closing ranks carries its children rather than leaving them to jump; a child's row, registered here too
// (setRowEl), rides inside its card's unit.
const unitOf = (el: HTMLElement): HTMLElement | undefined => el.closest<HTMLElement>(`[data-fold-unit]`) ?? undefined;
const heads = (el: HTMLElement, unit: HTMLElement | undefined): unit is HTMLElement => unit?.firstElementChild === el;

export interface MotionHost {
    // The board's lanes, where each card is about to stand.
    readonly lanes: Readonly<Ref<Record<FleetLane, FleetAgent[]>>>;
    readonly filtering: Readonly<Ref<boolean>>;
    // The card in the pointer's hand (useAgentDrag) moves with the ghost, not here.
    readonly drag: { readonly draggedId: Readonly<Ref<string | undefined>>; readonly dragging: Readonly<Ref<boolean>> };
    // What opens and shuts the trays under the cards (ChildRows): a render that moves it moves the cards below a tray.
    readonly folds?: () => string;
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
    // The order and folds last drawn, against which a render is asked whether anything can have moved.
    const motionKey = (): string => `${laneOrder(host.lanes.value)}#${host.folds?.() ?? ``}`;
    let drawn: string | undefined;
    onMounted(() => {
        drawn = motionKey();
    });
    // Every read before any write, here and after the render, so a render that moves cards is laid out once, not once
    // per card.
    onBeforeUpdate(() => {
        before.clear();
        if (motionKey() === drawn) {
            return;
        }
        const leaving: HTMLElement[] = [];
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
                leaving.push(el);
            }
        }
        for (const el of leaving) {
            el.style.opacity = `0`;
            el.style.pointerEvents = `none`;
        }
    });
    const canAnimate = (id: string, el: HTMLElement): boolean =>
        el.isConnected && !(host.drag.draggedId.value === id && host.drag.dragging.value) && typeof el.animate === `function`;
    onUpdated(() => {
        drawn = motionKey();
        if (before.size === 0) {
            return;
        }
        if (!lessMotion()) {
            const moving = [...cardEls].filter(([id, el]) => before.has(id) && canAnimate(id, el));
            // A slide still running would be read as where the card now stands.
            for (const [, el] of moving) {
                stopSlide(el);
                const unit = unitOf(el);
                if (unit !== undefined) {
                    stopSlide(unit);
                }
            }
            const moves = moving.map(([id, el]) => {
                const lane = laneOfEl(el);
                return [
                    el,
                    lane === undefined ? undefined : cardMove(before.get(id)!, { rect: el.getBoundingClientRect(), lane }, host.filtering.value),
                ] as const;
            });
            // What each unit's card slides it by, which every row inside it is carried by already.
            const carried = new Map<HTMLElement, number>();
            for (const [el, move] of moves) {
                const unit = unitOf(el);
                if (move?.kind === `reflow` && heads(el, unit)) {
                    carried.set(unit, move.dy);
                }
            }
            for (const [el, move] of moves) {
                if (move?.kind === `flight`) {
                    flyCard(el, move.dx, move.dy);
                }
                const unit = unitOf(el);
                if (move?.kind === `reflow` && heads(el, unit)) {
                    slideFrom(unit, move.dy);
                } else if (move?.kind === `reflow`) {
                    const own = move.dy - (unit === undefined ? 0 : (carried.get(unit) ?? 0));
                    if (Math.abs(own) >= 0.5) {
                        slideFrom(el, own);
                    }
                }
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
