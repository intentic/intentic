import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { FLASH_MS, flashElement } from "@intentic/ui/motion";

// Pins the glow a press (or a search answer) lights what it points at with: a one-pixel edge on the element's own border
// and a wash added over its ground, both fading over FLASH_MS, held still instead for a reader who asked for less motion,
// restarted rather than stacked by a second press, and nothing at all where there is no Web Animations API.

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
    it(`fades a one-pixel edge on the element's border and a wash added over its ground`, () => {
        flashElement(ringable());
        expect(played).toHaveLength(2);
        const [edge, wash] = played;
        expect(edge?.options.duration).toBe(FLASH_MS);
        expect(edge?.keyframes.every((frame) => frame[`outlineWidth`] === `1px` && frame[`outlineOffset`] === `-1px`)).toBe(true);
        expect(edge?.keyframes.at(-1)?.[`outlineColor`]).toBe(`transparent`);
        // Added to the element's own shadows, never in place of them: a card keeps its lift while it glows.
        expect(wash?.options.composite).toBe(`add`);
        expect(wash?.keyframes.every((frame) => String(frame[`boxShadow`]).startsWith(`inset`))).toBe(true);
        expect(wash?.keyframes.at(-1)?.[`boxShadow`]).toContain(`transparent`);
    });

    it(`holds the glow still for a reader who asked for less motion`, () => {
        stubGlobal(`matchMedia`, (query: string) => ({ matches: query === `(prefers-reduced-motion: reduce)`, media: query }));
        flashElement(ringable());
        const colors = played[0]?.keyframes.map((frame) => frame[`outlineColor`]);
        expect(new Set(colors).size).toBe(1);
        expect(colors?.[0]).not.toBe(`transparent`);
        const washes = played[1]?.keyframes.map((frame) => frame[`boxShadow`]);
        expect(new Set(washes).size).toBe(1);
    });

    it(`restarts the glow on a second press rather than stacking another`, () => {
        const el = ringable();
        flashElement(el);
        flashElement(el);
        expect(played.map((layer) => layer.cancelled)).toEqual([true, true, false, false]);
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
