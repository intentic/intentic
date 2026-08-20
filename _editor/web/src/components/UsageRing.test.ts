// @vitest-environment jsdom
//
// The usage circle and the card it opens. Driven through the real component, because the two things worth
// pinning are the two the old tooltip got wrong: that the breakdown arrives as a READABLE structure (a line and
// a meter per pool, each with its reset) rather than one run-on label, and that it lands BESIDE the ring — every
// surface that draws one is a column of rows, so a box over or under the ring covers the rows being compared.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { formatReset, type PlanHeadroom } from "../composables/chat/usageStatus";
import UsageRing from "./UsageRing.vue";

// The @intentic/ui barrel this component reaches for (the ring, the placement) calls window.matchMedia at
// import time, through useDevice — and jsdom ships no such thing.

const CARD = { width: 240, height: 180 };
// jsdom lays nothing out, so both boxes are handed the rects they would have had on screen: the ring where the
// test puts it, the card at the size its content gives it.
let ring = { left: 40, top: 100, width: 14, height: 14 };
const originalMeasure = Element.prototype.getBoundingClientRect;

const rectOf = (box: { left: number; top: number; width: number; height: number }): DOMRect =>
    ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top }) as DOMRect;

const RESETS_AT = 1_700_000_000;
const headroom = (over: Partial<PlanHeadroom> = {}): PlanHeadroom => ({
    percent: 91,
    tone: `text-warning`,
    stale: false,
    measuredAt: Date.now(),
    pools: [
        { kind: `five_hour`, label: `5-hour session`, percent: 56, resetsAt: RESETS_AT },
        { kind: `seven_day`, label: `Weekly · all models`, percent: 91, resetsAt: undefined },
    ],
    binding: { kind: `seven_day`, label: `Weekly · all models`, percent: 91, resetsAt: undefined },
    ...over,
});

// The ring, mounted — the element a pointer arrives on.
const mount = async (over: Partial<PlanHeadroom> = {}, flank?: `left` | `right`): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    createApp({ render: () => h(UsageRing, { headroom: headroom(over), flank }) }).mount(host);
    await nextTick();
    return host.querySelector(`span`) as HTMLElement;
};

const hover = async (anchor: HTMLElement): Promise<HTMLElement | null> => {
    anchor.dispatchEvent(new MouseEvent(`mouseenter`));
    vi.advanceTimersByTime(200); // past the open delay a pass-by sweep is meant to fall inside
    await nextTick();
    await nextTick(); // the card is measured and placed on the render after the one that created it
    return document.body.querySelector<HTMLElement>(`.ui-anchored`);
};

const card = async (over: Partial<PlanHeadroom> = {}): Promise<HTMLElement> => (await hover(await mount(over))) as HTMLElement;

beforeEach(() => {
    vi.useFakeTimers();
    ring = { left: 40, top: 100, width: 14, height: 14 };
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
        return rectOf(this.classList.contains(`ui-anchored`) ? { left: 0, top: 0, ...CARD } : ring);
    };
});

afterEach(() => {
    Element.prototype.getBoundingClientRect = originalMeasure;
    vi.useRealTimers();
    document.body.innerHTML = ``;
});

it(`lists every pool with its own figure and reset, and says how old the reading is`, async () => {
    const panel = await card();
    expect(panel.textContent).toContain(`5-hour session`);
    expect(panel.textContent).toContain(`56%`);
    expect(panel.textContent).toContain(`Weekly · all models`);
    expect(panel.textContent).toContain(`91%`);
    // A pool with no reset instant simply doesn't claim one — the other's is still named.
    expect(panel.textContent).toContain(`resets`);
    expect(panel.textContent).toContain(`measured just now`);
    // One meter per pool, so which allowance is about to bite is seen rather than parsed.
    expect(panel.querySelectorAll(`.bg-current`)).toHaveLength(2);
});

it(`speaks the whole breakdown beside the arc, since a card raised by a pointer never reaches a screen reader`, async () => {
    const anchor = await mount();
    // The weekday and clock are fixed, but they still land in the runner's timezone — so the expectation goes
    // through the same formatter rather than hardcoding an hour.
    const reset = formatReset(RESETS_AT);
    expect(anchor.querySelector(`.sr-only`)?.textContent).toBe(`5-hour session 56% (resets ${reset}) · Weekly · all models 91% · measured just now`);
});

it(`opens on the ring's right flank, clear of the rows it is being compared against`, async () => {
    const panel = await card();
    expect(panel.className).toContain(`ui-anchored-right`);
    expect(panel.style.left).toBe(`62px`); // the ring's right edge (54) + the 8px gap
});

it(`spills left when the ring OPENS its row, so the card misses the row's own name and buttons`, async () => {
    // The Agent tab's connection rows: the ring stands in for the status dot, at the row's left edge, with the
    // page gutter on its left and everything the row says on its right.
    ring = { left: 400, top: 100, width: 14, height: 14 };
    const panel = (await hover(await mount({}, `left`))) as HTMLElement;
    expect(panel.className).toContain(`ui-anchored-left`);
    expect(panel.style.left).toBe(`152px`); // the ring's left edge (400) − the gap − the card's width
});

it(`mirrors to the left flank for a ring against the window's right edge`, async () => {
    ring = { left: 990, top: 100, width: 14, height: 14 };
    const panel = await card();
    expect(panel.className).toContain(`ui-anchored-left`);
    expect(panel.style.left).toBe(`742px`); // the ring's left edge (990) − the gap − the card's width
});

it(`falls back to above the ring only when neither flank can hold the card`, async () => {
    // A pop-out window narrower than the card plus its gaps — the one case where sideways is impossible.
    Object.defineProperty(window, `innerWidth`, { value: 300, configurable: true });
    ring = { left: 100, top: 400, width: 14, height: 14 };
    const panel = await card();
    expect(panel.className).toContain(`ui-anchored-top`);
    expect(panel.style.top).toBe(`212px`); // the ring's top edge (400) − the gap − the card's height
    Object.defineProperty(window, `innerWidth`, { value: 1024, configurable: true });
});

it(`shows nothing for a pointer that only sweeps past, and closes the moment one leaves`, async () => {
    const anchor = await mount();
    anchor.dispatchEvent(new MouseEvent(`mouseenter`));
    anchor.dispatchEvent(new MouseEvent(`mouseleave`));
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(document.body.querySelector(`.ui-anchored`)).toBeNull();

    expect(await hover(anchor)).not.toBeNull();
    anchor.dispatchEvent(new MouseEvent(`mouseleave`));
    await nextTick();
    expect(document.body.querySelector(`.ui-anchored`)).toBeNull();
});

it(`explains the ≥ only while the reading is old enough to have been overtaken elsewhere`, async () => {
    expect((await card()).textContent).not.toContain(`≥`);
    document.body.innerHTML = ``;
    const stale = await card({ stale: true });
    expect(stale.textContent).toContain(`≥91%`);
    expect(stale.textContent).toContain(`these are floors`);
});
