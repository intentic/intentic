import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { useUsageTravel } from "./usageTravel";

// Pins when Usage left travels between its two homes (the board's corner, the chat's rail): a copy leaving one and a copy
// arriving in the other in the same render are one move, drawn as two pictures flying the path over the page while the
// arriving copy waits invisible under its own, and nothing is left behind once it lands. A copy only leaving (the board
// closed) or only arriving (a first sight) plays nothing, and neither does a reader who asked for less motion.

interface Played {
    readonly on: Element;
    readonly keyframes: Keyframe[];
    readonly options: KeyframeAnimationOptions;
    readonly cancelled: () => boolean;
}

describe(`useUsageTravel`, () => {
    const played: Played[] = [];
    // Lands every travel in flight, as the end of its path would.
    const landings: (() => void)[] = [];
    let app: App | undefined;

    beforeEach(() => {
        played.length = 0;
        landings.length = 0;
        // jsdom neither lays out nor animates: the corner stands low on the left, the rail high on the right.
        Object.defineProperty(Element.prototype, `animate`, {
            configurable: true,
            value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation {
                let cancelled = false;
                // SAFETY: the travel reads only `cancel` and `finished` off what it plays; `finished` is set just below.
                const run = {
                    cancel: (): void => {
                        cancelled = true;
                    },
                } as Animation;
                Object.defineProperty(run, `finished`, {
                    value: new Promise<Animation>((resolve) => {
                        landings.push(() => resolve(run));
                    }),
                });
                played.push({ on: this, keyframes, options, cancelled: () => cancelled });
                return run;
            },
        });
        jest.spyOn(Element.prototype, `getBoundingClientRect`).mockImplementation(function (this: Element) {
            const home = this.closest(`[data-home]`)?.getAttribute(`data-home`);
            const [left, top, width] = home === `board` ? [100, 400, 400] : home === `chat` ? [900, 40, 240] : [0, 0, 0];
            return DOMRect.fromRect({ x: left, y: top, width, height: width === 0 ? 0 : 300 });
        });
        stubGlobal(`matchMedia`, (query: string) => ({ matches: false, media: query }));
    });

    afterEach(() => {
        app?.unmount();
        app = undefined;
        for (const picture of document.body.querySelectorAll(`[aria-hidden="true"]`)) {
            picture.remove();
        }
        Reflect.deleteProperty(Element.prototype, `animate`);
        jest.restoreAllMocks();
        unstubAllGlobals();
    });

    // Usage left's copy, in whichever home it stands in now (null: in neither).
    const drawn = (first: `board` | `chat` | null) => {
        const home = ref(first);
        const Copy = defineComponent({
            setup() {
                const root = ref<HTMLElement>();
                useUsageTravel(root);
                return () => h(`section`, { ref: root, "aria-label": `Usage left` }, `71% left`);
            },
        });
        const Page = defineComponent({
            setup: () => () =>
                h(`div`, [
                    h(`div`, { "data-home": `board` }, home.value === `board` ? [h(Copy, { key: `board` })] : []),
                    h(`div`, { "data-home": `chat` }, home.value === `chat` ? [h(Copy, { key: `chat` })] : []),
                ]),
        });
        const root = document.createElement(`div`);
        document.body.appendChild(root);
        app = createApp(Page);
        app.mount(root);
        return { home, copy: (): HTMLElement | null => root.querySelector(`section`) };
    };
    const pictures = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(`:scope > section[aria-hidden="true"]`)];
    const settled = async (): Promise<void> => {
        await nextTick();
        await nextTick();
    };

    it(`flies from the corner it left to the rail it arrived in, holding the arriving copy until its picture lands`, async () => {
        const { home, copy } = drawn(`board`);
        await settled();
        expect(played).toHaveLength(0);

        home.value = `chat`;
        await settled();

        const arrived = copy()!;
        expect(arrived.closest(`[data-home]`)?.getAttribute(`data-home`)).toBe(`chat`);
        // One picture of the copy that left, one of the copy that arrived, both kept out of the reader's way.
        expect(pictures()).toHaveLength(2);
        for (const picture of pictures()) {
            expect(picture.inert).toBe(true);
            expect(picture.style.position).toBe(`fixed`);
        }
        // The arriving copy is held invisible, and its picture starts where the corner stood: 800 left, 360 down of the rail.
        const hold = played.find((run) => run.on === arrived);
        expect(hold?.keyframes).toEqual([{ opacity: 0 }, { opacity: 0 }]);
        expect(played.some((run) => run.on !== arrived && run.keyframes[0]?.[`translate`] === `-800px 360px`)).toBe(true);

        for (const land of landings) {
            land();
        }
        await settled();
        expect(pictures()).toHaveLength(0);
        expect(hold?.cancelled()).toBe(true);
    });

    it(`flies back the other way, from the rail into the corner`, async () => {
        const { home } = drawn(`chat`);
        await settled();

        home.value = `board`;
        await settled();

        expect(pictures()).toHaveLength(2);
        expect(played.some((run) => run.keyframes[0]?.[`translate`] === `800px -360px`)).toBe(true);
    });

    it(`plays nothing for a copy that only leaves or only arrives`, async () => {
        const { home } = drawn(null);
        await settled();
        home.value = `board`;
        await settled();
        expect(played).toHaveLength(0);

        home.value = null;
        await settled();
        expect(played).toHaveLength(0);
        expect(pictures()).toHaveLength(0);
    });

    it(`moves it at once for a reader who asked for less motion`, async () => {
        stubGlobal(`matchMedia`, (query: string) => ({ matches: query === `(prefers-reduced-motion: reduce)`, media: query }));
        const { home, copy } = drawn(`board`);
        await settled();

        home.value = `chat`;
        await settled();

        expect(copy()?.closest(`[data-home]`)?.getAttribute(`data-home`)).toBe(`chat`);
        expect(played).toHaveLength(0);
        expect(pictures()).toHaveLength(0);
    });
});
