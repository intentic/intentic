import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { type App, createApp, defineComponent, h, nextTick, ref, shallowRef } from "vue";
import type { FleetLane } from "../../fleet/agentStatus";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { cardMove, laneHolding, useLaneMotion } from "./laneMotion";

// Pins how cards move across a render: one that changes lanes flies from where it stood while its old copy is hidden,
// the cards it left close ranks unless a filter is on, the card in the pointer's hand and a reader who asked for less
// motion get none, and a card is scrolled to once it is drawn.

const card = (id: string): FleetAgent => ({
    id,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
});
const LANES: readonly FleetLane[] = [`attention`, `active`, `finished`];
const lanesOf = (active: string[], finished: string[]): Record<FleetLane, FleetAgent[]> => ({
    attention: [],
    active: active.map(card),
    finished: finished.map(card),
});

describe(`how a card moved`, () => {
    const at = (left: number, top: number, lane: FleetLane) => ({ rect: { left, top }, lane });

    it(`flies a card that changed lanes, back from where it stood`, () => {
        expect(cardMove(at(300, 0, `active`), at(600, 100, `finished`), false)).toEqual({ kind: `flight`, dx: -300, dy: -100 });
        expect(cardMove(at(300, 0, `active`), at(600, 100, `finished`), true)).toEqual({ kind: `flight`, dx: -300, dy: -100 });
    });

    it(`closes ranks within a lane unless a filter is on, and leaves a card that stayed put`, () => {
        expect(cardMove(at(300, 100, `active`), at(300, 0, `active`), false)).toEqual({ kind: `reflow`, dy: 100 });
        expect(cardMove(at(300, 100, `active`), at(300, 0, `active`), true)).toBeUndefined();
        expect(cardMove(at(300, 0, `active`), at(300, 0, `finished`), false)).toBeUndefined();
    });

    it(`finds the lane holding a card, left to right`, () => {
        const lanes = lanesOf([`a1`], [`f1`]);
        expect([laneHolding(lanes, `a1`), laneHolding(lanes, `f1`), laneHolding(lanes, `gone`)]).toEqual([`active`, `finished`, undefined]);
    });
});

describe(`cards moving across a render`, () => {
    const animations: { card: string | null; keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
    let app: App | undefined;

    beforeEach(() => {
        animations.length = 0;
        // jsdom neither lays out nor animates: a card stands at its lane's column and its place in it, 300 by 100.
        Object.defineProperty(Element.prototype, `animate`, {
            configurable: true,
            value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation {
                animations.push({ card: this.getAttribute(`aria-label`), keyframes, options });
                return { onfinish: null } as unknown as Animation;
            },
        });
        spyOn(Element.prototype, `getBoundingClientRect`).mockImplementation(function (this: Element) {
            const section = this.closest<HTMLElement>(`section[data-lane]`);
            const left = LANES.indexOf(section?.dataset[`lane`] as FleetLane) * 300;
            const top = section === null ? 0 : [...section.children].indexOf(this) * 100;
            return { left, top, right: left + 300, bottom: top + 100, width: 300, height: 100, x: left, y: top, toJSON: () => ({}) };
        });
    });

    afterEach(() => {
        app?.unmount();
        app = undefined;
        Reflect.deleteProperty(Element.prototype, `animate`);
        jest.restoreAllMocks();
        unstubAllGlobals();
    });

    // Lanes and cards drawn the way the board draws them: each card a component registered through its `:ref`.
    const drawn = (initial: Record<FleetLane, FleetAgent[]>) => {
        const host = {
            lanes: shallowRef(initial),
            filtering: ref(false),
            drag: { draggedId: ref<string | undefined>(undefined), dragging: ref(false) },
        };
        let motion: ReturnType<typeof useLaneMotion> | undefined;
        const Card = defineComponent({
            props: { id: { type: String, required: true } },
            setup: (props) => () => h(`div`, { "aria-label": props.id }),
        });
        const Board = defineComponent({
            setup() {
                const own = useLaneMotion(host);
                motion = own;
                return () =>
                    h(
                        `div`,
                        LANES.map((lane) =>
                            h(
                                `section`,
                                { key: lane, "data-lane": lane },
                                host.lanes.value[lane].map((agent) =>
                                    h(Card, { key: agent.id, id: agent.id, ref: (el) => own.setCardEl(agent.id, el) }),
                                ),
                            ),
                        ),
                    );
            },
        });
        const root = document.createElement(`div`);
        document.body.appendChild(root);
        app = createApp(Board);
        app.mount(root);
        const cardEl = (id: string): HTMLElement => root.querySelector<HTMLElement>(`[aria-label="${id}"]`)!;
        return { host, motion: motion!, cardEl };
    };

    it(`flies a card into its new lane, hiding the copy it leaves, and closes the ranks behind it`, async () => {
        const { host, motion, cardEl } = drawn(lanesOf([`a1`, `a2`], []));
        const leaving = cardEl(`a1`);

        host.lanes.value = lanesOf([`a2`], [`a1`]);
        expect(motion.isMovingLane(`a1`)).toBe(true);
        await nextTick();

        expect([leaving.style.opacity, leaving.style.pointerEvents]).toEqual([`0`, `none`]);
        expect(motion.isMovingLane(`a1`)).toBe(false);
        expect(animations.map(({ card: id, keyframes, options }) => ({ id, from: keyframes[0]![`transform`], duration: options.duration }))).toEqual([
            { id: `a1`, from: `translate3d(-300px, 0px, 0) scale(1.02)`, duration: 260 },
            { id: `a2`, from: `translate3d(0, 100px, 0)`, duration: 220 },
        ]);
    });

    it(`leaves the ranks alone under a filter, and never moves the card in the pointer's hand`, async () => {
        const { host } = drawn(lanesOf([`a1`, `a2`, `a3`], []));
        host.filtering.value = true;
        host.drag.draggedId.value = `a1`;
        host.drag.dragging.value = true;

        host.lanes.value = lanesOf([`a2`, `a3`], [`a1`]);
        await nextTick();

        expect(animations).toEqual([]);
    });

    it(`moves nothing for a reader who asked for less motion`, async () => {
        stubGlobal(`matchMedia`, (query: string) => ({ matches: query === `(prefers-reduced-motion: reduce)`, media: query }));
        const { host } = drawn(lanesOf([`a1`, `a2`], []));

        host.lanes.value = lanesOf([`a2`], [`a1`]);
        await nextTick();

        expect(animations).toEqual([]);
    });

    it(`scrolls a card into view once it is drawn, leaving a visible one where it is`, async () => {
        const scrolled: { card: string | null; options: boolean | ScrollIntoViewOptions | undefined }[] = [];
        spyOn(Element.prototype, `scrollIntoView`).mockImplementation(function (this: Element, options?: boolean | ScrollIntoViewOptions) {
            scrolled.push({ card: this.getAttribute(`aria-label`), options });
        });
        const { host, motion } = drawn(lanesOf([`a1`], []));

        host.lanes.value = lanesOf([`a1`, `a2`], []);
        await motion.revealCard(`a2`);

        expect(scrolled).toEqual([{ card: `a2`, options: { block: `nearest` } }]);
    });
});
