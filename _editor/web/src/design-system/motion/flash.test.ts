import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { FLASH_MS, flashElement } from "@intentic/ui/motion";

// Pins the ring a press draws round what it points at: an outline that fades over FLASH_MS, held still instead for a
// reader who asked for less motion, restarted rather than stacked by a second press, and nothing at all where there is no
// Web Animations API.

interface Played {
    readonly keyframes: Keyframe[];
    readonly options: KeyframeAnimationOptions;
    cancelled: boolean;
}

const played: Played[] = [];

// jsdom does not animate: each ring is recorded, and stands as one of the element's animations until cancelled.
const ringable = (): HTMLElement => {
    const el = document.createElement(`div`);
    const running: Animation[] = [];
    el.animate = ((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
        const record: Played = { keyframes, options, cancelled: false };
        played.push(record);
        // SAFETY: the ring reads only `id` and `cancel` back from what it started.
        const animation = { id: options.id, cancel: () => (record.cancelled = true) } as unknown as Animation;
        running.push(animation);
        return animation;
    }) as HTMLElement[`animate`];
    el.getAnimations = () => running;
    return el;
};

afterEach(() => {
    played.length = 0;
    unstubAllGlobals();
});

describe(`flashElement`, () => {
    it(`fades an outline drawn inside the element's own edge`, () => {
        flashElement(ringable());
        expect(played).toHaveLength(1);
        const [ring] = played;
        expect(ring?.options.duration).toBe(FLASH_MS);
        expect(ring?.keyframes.every((frame) => frame[`outlineStyle`] === `solid` && frame[`outlineOffset`] === `-2px`)).toBe(true);
        expect(ring?.keyframes.at(-1)?.[`outlineColor`]).toBe(`transparent`);
    });

    it(`holds the ring still for a reader who asked for less motion`, () => {
        stubGlobal(`matchMedia`, (query: string) => ({ matches: query === `(prefers-reduced-motion: reduce)`, media: query }));
        flashElement(ringable());
        const colors = played[0]?.keyframes.map((frame) => frame[`outlineColor`]);
        expect(new Set(colors).size).toBe(1);
        expect(colors?.[0]).not.toBe(`transparent`);
    });

    it(`restarts the ring on a second press rather than stacking another`, () => {
        const el = ringable();
        flashElement(el);
        flashElement(el);
        expect(played.map((ring) => ring.cancelled)).toEqual([true, false]);
    });

    it(`rings nothing where there is no element or no Web Animations`, () => {
        const bare = document.createElement(`div`);
        // Whatever another suite left on Element.prototype, this element has no Web Animations.
        Object.defineProperty(bare, `animate`, { value: undefined });
        expect(() => flashElement(null)).not.toThrow();
        expect(() => flashElement(bare)).not.toThrow();
        expect(played).toHaveLength(0);
    });
});
