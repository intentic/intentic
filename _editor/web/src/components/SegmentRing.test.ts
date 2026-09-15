// @vitest-environment jsdom
// The kit's segmented ring, tested from its consumer: @intentic/ui carries no test harness of its own, and the agent
// cards here are the only thing that draws one. What is asserted is the dash geometry, because it fails silently —
// a pattern whose total misses the circumference repeats onto the unlit rim as ghost ticks nobody can read as wrong.
import { SegmentRing } from "@intentic/ui";
import { expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";

const SIZE = 28;
const STROKE = 1.5;
// The same construction ProgressRing uses: the arc rides the middle of the stroke, so the radius is inset by half of it.
const CIRCUMFERENCE = 2 * Math.PI * ((SIZE - STROKE) / 2);

const mount = async (segments: number, filled: number, size = SIZE): Promise<SVGElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    createApp({ render: () => h(SegmentRing, { segments, filled, size, stroke: STROKE }) }).mount(host);
    await nextTick();
    return host.querySelector(`svg`) as SVGElement;
};

// [dash, gap, dash, gap, …] as drawn; the odd entries are the holes.
const dashesOf = (circle: Element | null): number[] =>
    circle === null ? [] : (circle.getAttribute(`stroke-dasharray`) ?? ``).split(` `).map(Number);

const total = (pattern: number[]): number => pattern.reduce((sum, part) => sum + part, 0);
const inked = (pattern: number[]): number => pattern.filter((_, at) => at % 2 === 0).reduce((sum, part) => sum + part, 0);
// Read off the track's own pattern rather than restated here: the gap width is the component's business, and a test
// that transcribed it would pass on a ring drawn to the wrong construction.
const holes = (pattern: number[]): number => total(pattern) - inked(pattern);

const rings = (svg: SVGElement): { track: number[]; arc: number[] } => {
    const circles = [...svg.querySelectorAll(`circle`)];
    return { track: dashesOf(circles[0] ?? null), arc: dashesOf(circles[1] ?? null) };
};

it(`cuts the rim into exactly as many slots as it was given`, async () => {
    const { track } = rings(await mount(5, 2));
    // One repeating [dash, gap] pair, laid down once per slot: five of them must close the circle to the pixel.
    expect(track).toHaveLength(2);
    expect(total(track) * 5).toBeCloseTo(CIRCUMFERENCE, 6);
});

// The invariant the component's own comment claims: the lit pattern is one circumference long, so the browser lays it
// down once. A shorter one repeats, painting lit ticks over slots that are not done.
it(`spends exactly one circumference on the lit pattern, whatever is lit`, async () => {
    // From one lit slot to every one of them; a ring with nothing lit draws no pattern at all and is its own case below.
    for (const filled of [1, 4, 5]) {
        expect(total(rings(await mount(5, filled)).arc)).toBeCloseTo(CIRCUMFERENCE, 6);
    }
});

it(`inks one slot's worth of rim per completed item`, async () => {
    const { track, arc } = rings(await mount(5, 2));
    expect(inked(arc)).toBeCloseTo(inked(track) * 2, 6);
});

// A ring with nothing done draws no accent circle at all, rather than a zero-length arc that a round cap would still
// show as a dot at twelve o'clock.
it(`draws no lit circle before the first item is done`, async () => {
    expect(rings(await mount(5, 0)).arc).toEqual([]);
});

it(`never lights more slots than it has, however many it is told are done`, async () => {
    const { track, arc } = rings(await mount(3, 9));
    expect(inked(arc)).toBeCloseTo(inked(track) * 3, 6);
});

// PAST ~16 ITEMS THE GAPS CLOSE. A 28px rim cut 30 ways has 2.8px per slot, too little for a tick and a hole both, so
// the ring degrades to a plain arc: the proportion stays honest, only the counting is gone. Beats clamping the count,
// which would draw a full ring for a list still half open.
it(`closes the gaps rather than drawing ticks too small to count`, async () => {
    const { track, arc } = rings(await mount(30, 10));
    expect(holes(track)).toBe(0);
    expect(inked(arc)).toBeCloseTo(CIRCUMFERENCE / 3, 6);
});

it(`keeps the ticks while a list is small enough to count`, async () => {
    expect(holes(rings(await mount(12, 3)).track)).toBeGreaterThan(0);
});

// The rail draws the same ring four pixels smaller; its slots must still close the circle at that size.
it(`holds the construction at the rail's size`, async () => {
    const { track } = rings(await mount(4, 1, 24));
    expect(total(track) * 4).toBeCloseTo(2 * Math.PI * ((24 - STROKE) / 2), 6);
});
