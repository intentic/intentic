// Tests the usage meter and its card: the breakdown renders as a per-pool line and meter with its own reset, not
// one run-on label, and the card opens beside the meter rather than over the column of rows being compared.
import "@intentic/testing/dom";
import { createApp, h, nextTick } from "vue";
import { formatReset, type PlanHeadroom, type PlanLimitPool } from "../../features/chat/session/usageStatus";
import UsageMeter from "../UsageMeter.vue";

// The @intentic/ui barrel calls window.matchMedia at import time (via useDevice), which jsdom doesn't provide.

const CARD = { width: 240, height: 180 };
// jsdom lays out nothing; rects are supplied manually: the meter where the test puts it, the card at its size.
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
    unread: undefined,
    pools: [
        { kind: `five_hour`, label: `5-hour session`, percent: 56, resetsAt: RESETS_AT, gates: `all` },
        { kind: `seven_day`, label: `Weekly · all models`, percent: 91, resetsAt: undefined, gates: `all` },
    ],
    binding: { kind: `seven_day`, label: `Weekly · all models`, percent: 91, resetsAt: undefined, gates: `all` },
    ...over,
});

// The ring, mounted: the element a pointer arrives on.
const mount = async (over: Partial<PlanHeadroom> = {}, flank?: `left` | `right`): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    createApp({ render: () => h(UsageMeter, { headroom: headroom(over), flank }) }).mount(host);
    await nextTick();
    return host.querySelector(`span`) as HTMLElement;
};

const hover = async (anchor: HTMLElement): Promise<HTMLElement | null> => {
    anchor.dispatchEvent(new MouseEvent(`mouseenter`));
    jest.advanceTimersByTime(200); // past the open delay a pass-by sweep is meant to fall inside
    await nextTick();
    await nextTick(); // measured and placed on the render after the one that created it
    return document.body.querySelector<HTMLElement>(`.ui-anchored`);
};

const card = async (over: Partial<PlanHeadroom> = {}): Promise<HTMLElement> => (await hover(await mount(over))) as HTMLElement;

beforeEach(() => {
    jest.useFakeTimers();
    ring = { left: 40, top: 100, width: 14, height: 14 };
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
        return rectOf(this.classList.contains(`ui-anchored`) ? { left: 0, top: 0, ...CARD } : ring);
    };
});

afterEach(() => {
    Element.prototype.getBoundingClientRect = originalMeasure;
    jest.useRealTimers();
    document.body.innerHTML = ``;
});

// Plan usage is a bar everywhere; a ring is context. One hairline per account-wide pool, weekly first as the card
// orders them, so a roomy 5-hour session can't stand in for a spent week.
it(`draws a bar per account-wide pool, not a ring`, async () => {
    const anchor = await mount({
        pools: [
            { kind: `seven_day`, label: `Weekly · all models`, percent: 91, resetsAt: undefined, gates: `all` },
            { kind: `five_hour`, label: `5-hour session`, percent: 56, resetsAt: RESETS_AT, gates: `all` },
            { kind: `model:Fable`, label: `Weekly · Fable`, percent: 30, resetsAt: undefined, gates: { models: [`Fable`] } },
        ],
    });
    expect(anchor.querySelector(`svg`)).toBeNull();
    expect([...anchor.querySelectorAll<HTMLElement>(`.ui-meter-fill`)].map((fill) => fill.style.width)).toEqual([`9%`, `44%`]);
});

it(`adds the binding pool when it is a per-model slice, and draws one full bar when every pool has reset`, async () => {
    const fable: PlanLimitPool = { kind: `model:Fable`, label: `Weekly · Fable`, percent: 100, resetsAt: undefined, gates: { models: [`Fable`] } };
    const sliced = await mount({ pools: [headroom().pools[1]!, fable], binding: fable });
    expect(sliced.querySelectorAll(`.ui-meter-fill`)).toHaveLength(2);
    document.body.innerHTML = ``;
    const reset = await mount({ percent: 0, pools: [], binding: undefined });
    expect([...reset.querySelectorAll<HTMLElement>(`.ui-meter-fill`)].map((fill) => fill.style.width)).toEqual([`100%`]);
});

it(`lists every pool with its own figure and reset, and says how old the reading is`, async () => {
    const pools = headroom().pools;
    const panel = await card();
    for (const pool of pools) {
        expect(panel.textContent).toContain(pool.label);
        expect(panel.textContent).toContain(`${100 - pool.percent}% left`);
    }
    // A pool with no reset simply claims none; the other pool's reset is still named.
    expect(panel.textContent).toContain(formatReset(RESETS_AT));
    // One meter per pool: which allowance is about to bite is seen, not parsed.
    expect(panel.querySelectorAll(`.ui-meter-fill`)).toHaveLength(pools.length);
    // Each drains: as wide as what is left, never as what was spent. The week leads, the session nested under it.
    expect([...panel.querySelectorAll<HTMLElement>(`.ui-meter-fill`)].map((fill) => fill.style.width)).toEqual([`9%`, `44%`]);
});

// The chat rail's tree, in the picker's card: a spent week holds the session and a per-model week inside it, so
// their room is drawn neutral rather than green, and they name what they wait on instead of their own reset.
it(`nests pools inside the week, and holds them in neutral while the week is spent`, async () => {
    const week: PlanLimitPool = { kind: `seven_day`, label: `Weekly · all models`, percent: 100, resetsAt: RESETS_AT, gates: `all` };
    const session: PlanLimitPool = { kind: `five_hour`, label: `5-hour session`, percent: 0, resetsAt: RESETS_AT + 3600, gates: `all` };
    const fable: PlanLimitPool = { kind: `model:Fable`, label: `Weekly · Fable`, percent: 8, resetsAt: RESETS_AT, gates: { models: [`Fable`] } };
    const panel = await card({ percent: 100, tone: `text-danger`, pools: [week, session, fable], binding: week });
    const fills = [...panel.querySelectorAll<HTMLElement>(`.ui-meter-fill`)];
    expect(fills.map((fill) => fill.style.width)).toEqual([`0%`, `100%`, `92%`]);
    expect(fills.slice(1).every((fill) => fill.classList.contains(`text-subtle`) && !fill.classList.contains(`text-success`))).toBe(true);
    expect(panel.textContent?.match(/on hold until Weekly · all models resets/gu)).toHaveLength(2);
    expect(panel.textContent).not.toContain(formatReset(RESETS_AT + 3600));
    // The inline hairlines agree: the week spent, the session beside it held, not green.
    const anchor = document.body.querySelector(`span`) as HTMLElement;
    const hairlines = [...anchor.querySelectorAll<HTMLElement>(`[aria-hidden="true"] .ui-meter-fill`)];
    expect(hairlines[1]?.classList.contains(`text-subtle`)).toBe(true);
});

// Separate lanes (Claude and Gemini on one Google plan) don't hold each other: a spent one leaves the other green.
it(`leaves a sibling lane usable when a lane beside it, not above it, is spent`, async () => {
    const claude: PlanLimitPool = {
        kind: `model:claude`,
        label: `Weekly · Claude`,
        percent: 100,
        resetsAt: RESETS_AT,
        gates: { models: [`claude`] },
    };
    const gemini: PlanLimitPool = { kind: `model:gemini`, label: `Weekly · Gemini`, percent: 20, resetsAt: RESETS_AT, gates: { models: [`gemini`] } };
    const panel = await card({ percent: 100, pools: [claude, gemini], binding: claude });
    expect(panel.textContent).not.toContain(`on hold`);
    expect(panel.querySelectorAll(`.ui-meter-fill`)[1]?.classList.contains(`text-success`)).toBe(true);
});

it(`speaks the whole breakdown beside the bars, since a card raised by a pointer never reaches a screen reader`, async () => {
    const anchor = await mount();
    const spoken = anchor.querySelector(`.sr-only`)?.textContent ?? ``;
    const pools = headroom().pools;
    for (const pool of pools) {
        expect(spoken).toContain(pool.label);
        expect(spoken).toContain(`${100 - pool.percent}% left`);
    }
    expect(spoken).toContain(formatReset(RESETS_AT));
});

it(`opens on the meter's right flank, clear of the rows it is being compared against`, async () => {
    const panel = await card();
    expect(panel.className).toContain(`ui-anchored-right`);
    expect(panel.style.left).toBe(`62px`); // the meter's right edge (54) + the 8px gap
});

it(`spills left when the meter OPENS its row, so the card misses the row's own name and buttons`, async () => {
    // Agent tab connection rows: the meter stands in for the status dot at the row's edge, gutter on its left.
    ring = { left: 400, top: 100, width: 14, height: 14 };
    const panel = (await hover(await mount({}, `left`))) as HTMLElement;
    expect(panel.className).toContain(`ui-anchored-left`);
    expect(panel.style.left).toBe(`152px`); // the meter's left edge (400) − the gap − the card's width
});

it(`mirrors to the left flank for a meter against the window's right edge`, async () => {
    ring = { left: 990, top: 100, width: 14, height: 14 };
    const panel = await card();
    expect(panel.className).toContain(`ui-anchored-left`);
    expect(panel.style.left).toBe(`742px`); // the meter's left edge (990) − the gap − the card's width
});

it(`falls back to above the meter only when neither flank can hold the card`, async () => {
    // Pop-out narrower than the card plus its gaps: the one case sideways placement is impossible.
    Object.defineProperty(window, `innerWidth`, { value: 300, configurable: true });
    ring = { left: 100, top: 400, width: 14, height: 14 };
    const panel = await card();
    expect(panel.className).toContain(`ui-anchored-top`);
    expect(panel.style.top).toBe(`212px`); // the meter's top edge (400) − the gap − the card's height
    Object.defineProperty(window, `innerWidth`, { value: 1024, configurable: true });
});

it(`shows nothing for a pointer that only sweeps past, and closes the moment one leaves`, async () => {
    const anchor = await mount();
    anchor.dispatchEvent(new MouseEvent(`mouseenter`));
    anchor.dispatchEvent(new MouseEvent(`mouseleave`));
    jest.advanceTimersByTime(200);
    await nextTick();
    expect(document.body.querySelector(`.ui-anchored`)).toBeNull();

    expect(await hover(anchor)).not.toBeNull();
    anchor.dispatchEvent(new MouseEvent(`mouseleave`));
    await nextTick();
    expect(document.body.querySelector(`.ui-anchored`)).toBeNull();
});

it(`explains the ≤ only while the reading is old enough to have been overtaken elsewhere`, async () => {
    const fresh = await card();
    expect(fresh.textContent).not.toContain(`≤`);
    document.body.innerHTML = ``;
    const stale = await card({ stale: true });
    expect(stale.textContent).toContain(`≤${100 - headroom().percent}% left`);
    expect(stale.textContent).not.toBe(fresh.textContent);
});
