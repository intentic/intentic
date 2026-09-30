import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { FOLD_MS, trayFold, useFoldFlip } from "./foldMotion";

// Pins how a tray folds and how what stands below it makes room: the tray takes its height at once and its rows slide
// out of its top edge; shutting, it leaves the flow where it stood and its rows slide back up; the column's units slide
// from where they stood, one inside another only by what its own move exceeds; a reader who asked for less motion gets
// a fade and no slide, and a page with no Web Animations folds at once.

interface Played {
    readonly el: string | null;
    readonly keyframes: Keyframe[];
    readonly options: KeyframeAnimationOptions;
    readonly finish: () => void;
}

describe(`folding`, () => {
    const played: Played[] = [];
    let app: App | undefined;

    beforeEach(() => {
        played.length = 0;
        // jsdom neither lays out nor animates: an animation is recorded and finishes when the test says so.
        Object.defineProperty(Element.prototype, `animate`, {
            configurable: true,
            value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation {
                let finish = (): void => {};
                const finished = new Promise<void>((resolve) => {
                    finish = resolve;
                });
                played.push({ el: this.getAttribute(`aria-label`), keyframes, options, finish: () => finish() });
                return { finished, cancel: () => {} } as unknown as Animation;
            },
        });
    });

    afterEach(() => {
        app?.unmount();
        app = undefined;
        Reflect.deleteProperty(Element.prototype, `animate`);
        jest.restoreAllMocks();
        unstubAllGlobals();
    });

    // A tray's fold box, 120 tall and 40 down its card's column, holding its rows.
    const trayBox = (): { box: HTMLElement; rows: HTMLElement } => {
        const box = document.createElement(`div`);
        const rows = document.createElement(`div`);
        rows.setAttribute(`aria-label`, `rows`);
        box.appendChild(rows);
        document.body.appendChild(box);
        Object.defineProperty(box, `offsetHeight`, { configurable: true, value: 120 });
        Object.defineProperty(box, `offsetTop`, { configurable: true, value: 40 });
        return { box, rows };
    };
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    it(`opens with the rows sliding out of the box's top edge, clipped until they land`, async () => {
        const { box } = trayBox();
        const done = jest.fn();

        trayFold.enter(box, done);

        expect(played.map(({ el, keyframes, options }) => ({ el, keyframes, duration: options.duration }))).toEqual([
            {
                el: `rows`,
                keyframes: [
                    { translate: `0 -120px`, opacity: 0 },
                    { translate: `0 0`, opacity: 1 },
                ],
                duration: FOLD_MS,
            },
        ]);
        expect([box.style.overflow, done.mock.calls.length]).toEqual([`clip`, 0]);
        played[0]!.finish();
        await flush();
        expect([box.style.overflow, done.mock.calls.length]).toEqual([``, 1]);
    });

    it(`shuts by leaving the flow where it stood, the rows sliding back up under the card`, async () => {
        const { box } = trayBox();
        const done = jest.fn();

        trayFold.leave(box, done);

        expect([box.style.position, box.style.top, box.style.left, box.style.right, box.style.overflow]).toEqual([
            `absolute`,
            `40px`,
            `0px`,
            `0px`,
            `clip`,
        ]);
        expect(played.map(({ el, keyframes }) => ({ el, to: keyframes[1] }))).toEqual([{ el: `rows`, to: { translate: `0 -120px`, opacity: 0 } }]);
        expect(played[0]!.options.fill).toBe(`forwards`);
        played[0]!.finish();
        await flush();
        expect(done).toHaveBeenCalledTimes(1);
    });

    it(`fades the rows in where they stand, and shuts at once, for a reader who asked for less motion`, () => {
        stubGlobal(`matchMedia`, (query: string) => ({ matches: query === `(prefers-reduced-motion: reduce)`, media: query }));
        const { box } = trayBox();
        const done = jest.fn();

        trayFold.enter(box, () => {});
        trayFold.leave(box, done);

        expect(played.map(({ keyframes }) => keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
        expect([box.style.position, done.mock.calls.length]).toEqual([``, 1]);
    });

    it(`folds at once on a page with no Web Animations`, () => {
        Reflect.deleteProperty(Element.prototype, `animate`);
        const { box } = trayBox();
        const opened = jest.fn();
        const shut = jest.fn();

        trayFold.enter(box, opened);
        trayFold.leave(box, shut);

        expect([opened.mock.calls.length, shut.mock.calls.length, box.style.position]).toEqual([1, 1, ``]);
    });

    it(`slides the column's units from where they stood, a unit inside another by its own move alone`, async () => {
        // Two lanes, each a unit holding row units. Opening the tray over row b1 moves b1 down 30; the whole of lane B
        // moves 50 (a tray in lane A opened too), which its rows are carried by.
        const opened = ref(false);
        const tops: Record<string, [number, number]> = {
            "lane a": [0, 0],
            "row a1": [20, 20],
            "lane b": [200, 250],
            "row b0": [220, 270],
            "row b1": [260, 340],
        };
        jest.spyOn(Element.prototype, `getBoundingClientRect`).mockImplementation(function (this: Element) {
            // Laid out as drawn, not as the state now says: the render that moves it has not happened yet before it.
            const drawnOpen = this.closest(`[data-open]`)?.getAttribute(`data-open`) === `true`;
            const top = tops[this.getAttribute(`aria-label`) ?? ``]?.[drawnOpen ? 1 : 0] ?? 0;
            return { left: 0, top, right: 100, bottom: top + 10, width: 100, height: 10, x: 0, y: top, toJSON: () => ({}) };
        });
        const unit = (label: string, children: ReturnType<typeof h>[] = []) => h(`div`, { "data-fold-unit": ``, "aria-label": label }, children);
        const Column = defineComponent({
            setup() {
                const root = ref<HTMLElement | undefined>(undefined);
                useFoldFlip(root, () => opened.value);
                return () =>
                    h(`div`, { ref: root, "aria-label": `column`, "data-open": String(opened.value) }, [
                        unit(`lane a`, [unit(`row a1`)]),
                        unit(`lane b`, [unit(`row b0`), unit(`row b1`)]),
                    ]);
            },
        });
        const host = document.createElement(`div`);
        document.body.appendChild(host);
        app = createApp(Column);
        app.mount(host);

        opened.value = true;
        await nextTick();

        expect(played.map(({ el, keyframes, options }) => ({ el, from: keyframes[0]![`translate`], duration: options.duration }))).toEqual([
            { el: `lane b`, from: `0 -50px`, duration: FOLD_MS },
            { el: `row b1`, from: `0 -30px`, duration: FOLD_MS },
        ]);
    });
});
