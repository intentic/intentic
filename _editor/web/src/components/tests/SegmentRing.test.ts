// The kit's segmented ring, tested from its consumer: @intentic/ui carries no test harness of its own, and the agent
// cards here are the only thing that draws one. What is asserted is the dash geometry, because it fails silently —
// a pattern whose total misses the circumference repeats onto the unlit rim as ghost ticks nobody can read as wrong.
import "@intentic/testing/dom";
import { SegmentRing } from "@intentic/ui";
import { createApp, h, nextTick } from "vue";

const SIZE = 28;
const STROKE = 1.5;
// The same construction ProgressRing uses: the arc rides the middle of the stroke, so the radius is inset by half of it.
const CIRCUMFERENCE = 2 * Math.PI * ((SIZE - STROKE) / 2);

type Extra = { active?: number; asking?: boolean; seal?: `open` | `active` | `closed` };

const mount = async (segments: number, filled: number, size = SIZE, extra: Extra = {}): Promise<SVGElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    createApp({ render: () => h(SegmentRing, { segments, filled, size, stroke: STROKE, ...extra }) }).mount(host);
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

const part = (svg: SVGElement, name: string): Element | null => svg.querySelector(`[data-part="${name}"]`);
// A part the test needs drawn: missing, it fails here by name instead of as a read off null further down.
const drawn = (svg: SVGElement, name: string): SVGElement => {
    const found = part(svg, name);
    if (!(found instanceof SVGElement)) {
        throw new Error(`the ring drew no ${name}`);
    }
    return found;
};
const rings = (svg: SVGElement): { track: number[]; arc: number[]; hand: number[] } => ({
    track: dashesOf(part(svg, `track`)),
    arc: dashesOf(part(svg, `lit`)),
    hand: dashesOf(part(svg, `active`)),
});

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

// A ring with one segment and no seal must read as a closed ring, not one notched at twelve o'clock by a gap with no
// neighbour to keep apart.
it(`closes a lone segment into a whole ring`, async () => {
    const { track, arc } = rings(await mount(1, 1));
    expect(holes(track)).toBe(0);
    expect(inked(arc)).toBeCloseTo(CIRCUMFERENCE, 6);
});

// ITEMS IN HAND come straight after the lit ones, so the hand's pattern opens on a hole as long as the lit slots.
it(`draws the items in hand right after the done ones`, async () => {
    const svg = await mount(5, 2, SIZE, { active: 1 });
    const { track, arc, hand } = rings(svg);
    expect(total(hand)).toBeCloseTo(CIRCUMFERENCE, 6);
    expect(inked(hand)).toBeCloseTo(inked(track), 6);
    // [0, two slots, one tick, the rest]: nothing inked before the third slot.
    expect(hand[0]).toBe(0);
    expect(hand[1]).toBeCloseTo((CIRCUMFERENCE / 5) * 2, 6);
    expect(inked(arc)).toBeCloseTo(inked(track) * 2, 6);
});

it(`never holds more items in hand than the list has left`, async () => {
    const { track, hand } = rings(await mount(3, 2, SIZE, { active: 4 }));
    expect(inked(hand)).toBeCloseTo(inked(track), 6);
});

// Working is the lit ink, part-strength; asked is the info ink at full strength, so the two read apart by hue. (jsdom
// reads `currentColor` back lowercased.)
it(`inks an item in hand by whose move it is`, async () => {
    const working = drawn(await mount(5, 2, SIZE, { active: 1 }), `active`);
    expect(working.style.stroke).toBe(`currentcolor`);
    expect(Number(working.style.strokeOpacity)).toBeLessThan(1);
    const asked = drawn(await mount(5, 2, SIZE, { active: 1, asking: true }), `active`);
    expect(asked.style.stroke).toBe(`var(--color-info)`);
    expect(asked.style.strokeOpacity).toBe(``);
});

// THE SEAL IS NOT A SEGMENT: the ticks stay one per item and share what the bead's notch leaves of the rim.
it(`keeps one tick per item beside the seal, with a notch for the bead at 12 o'clock`, async () => {
    const svg = await mount(5, 5, SIZE, { seal: `closed` });
    const { track, arc } = rings(svg);
    const ticks = track.filter((_, at) => at % 2 === 0);
    expect(ticks).toHaveLength(5);
    expect(total(track)).toBeCloseTo(CIRCUMFERENCE, 6);
    expect(total(arc)).toBeCloseTo(CIRCUMFERENCE, 6);
    const bead = drawn(svg, `seal`);
    const notch = track.at(-1) ?? 0;
    // The notch is wider than the bead, and the ticks are shifted half of it past 12 o'clock so it sits centred.
    expect(notch).toBeGreaterThan(2 * Number(bead.getAttribute(`r`)));
    expect(Number(drawn(svg, `track`).getAttribute(`stroke-dashoffset`))).toBeCloseTo(-notch / 2, 6);
    // At the path's start, which the ring's -90° turn puts at 12 o'clock.
    expect(Number(bead.getAttribute(`cx`))).toBeCloseTo(SIZE / 2 + (SIZE - STROKE) / 2, 6);
});

// With a seal, the "whole ring" a lone segment closes into would cover the bead.
it(`keeps the notch open on a lone segment that has a seal`, async () => {
    const { track } = rings(await mount(1, 1, SIZE, { seal: `closed` }));
    expect(holes(track)).toBeGreaterThan(0);
});

it(`draws the seal faint while to come, part-lit in hand, whole once done`, async () => {
    const bead = async (extra: Extra): Promise<SVGElement> => drawn(await mount(5, 5, SIZE, extra), `seal`);
    expect((await bead({ seal: `open` })).style.fill).toContain(`var(--color-content)`);
    const inHand = await bead({ seal: `active` });
    expect(inHand.style.fill).toBe(`currentcolor`);
    expect(Number(inHand.style.fillOpacity)).toBeLessThan(1);
    expect((await bead({ seal: `active`, asking: true })).style.fill).toBe(`var(--color-info)`);
    const closed = await bead({ seal: `closed` });
    expect(closed.style.fill).toBe(`currentcolor`);
    expect(Number(closed.style.fillOpacity)).toBe(1);
});

it(`draws no bead and no notch without a seal`, async () => {
    const svg = await mount(5, 5);
    expect(part(svg, `seal`)).toBeNull();
    expect(rings(svg).track).toHaveLength(2);
});
