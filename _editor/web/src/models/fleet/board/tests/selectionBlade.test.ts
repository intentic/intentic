import { nextTick, ref } from "vue";
import { useSelectionBlade } from "../selectionBlade";

// Pins the blade's shape where a browser cannot be asked: the perf harness pauses every SMIL clock, so a blade that
// repaints its card on every frame reads the same there as one that sleeps. While any SMIL animation in an image is active
// the browser redraws the image each frame, held value or not, so the still stretch between sweeps has to fall outside
// every animation's active interval (../selectionBlade.ts measured what holding it inside one cost an idle board).

const svgOf = (style: Record<string, string> | undefined): Document => {
    const url = style?.[`--session-card-blade`] ?? ``;
    const prefix = `url("data:image/svg+xml,`;
    expect(url.startsWith(prefix)).toBe(true);
    return new DOMParser().parseFromString(decodeURIComponent(url.slice(prefix.length, -2)), `image/svg+xml`);
};

test(`each sweep is its own interval that ends frozen, so nothing is active between sweeps`, () => {
    const animations = [...svgOf(useSelectionBlade(() => true).value).querySelectorAll(`animate`)];
    expect(animations.map((animation) => animation.getAttribute(`attributeName`))).toEqual([`x1`, `x2`]);
    for (const animation of animations) {
        // One segment: a second value to hold would be a still stretch inside the active interval.
        expect(animation.getAttribute(`values`)?.split(`;`)).toHaveLength(2);
        expect(animation.getAttribute(`fill`)).toBe(`freeze`);
        expect(animation.hasAttribute(`repeatCount`) || animation.hasAttribute(`repeatDur`)).toBe(false);
    }
    // The first begins on the image's first frame and again 6.48s after each end: one sweep every 8s.
    const [x1, x2] = animations;
    expect(Number.parseFloat(x1?.getAttribute(`dur`) ?? ``) + Number.parseFloat(/\.end\+([\d.]+)s/u.exec(x1?.getAttribute(`begin`) ?? ``)?.[1] ?? ``)).toBe(8);
    expect(x1?.getAttribute(`begin`)?.startsWith(`0s;${x1.id}.end+`)).toBe(true);
    expect(x2?.getAttribute(`begin`)).toBe(`${x1?.id}.begin`);
    expect(x2?.getAttribute(`dur`)).toBe(x1?.getAttribute(`dur`));
});

test(`a new selection mints a new image, so its sweep starts on the click; none while unselected`, async () => {
    const selected = ref<string | undefined>(`a`);
    const style = useSelectionBlade(() => selected.value);
    const first = style.value?.[`--session-card-blade`];
    selected.value = `b`;
    await nextTick();
    const second = style.value?.[`--session-card-blade`];
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    selected.value = undefined;
    await nextTick();
    expect(style.value).toBeUndefined();
});
