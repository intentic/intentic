// jsdom pins the table's bounded-scroll contract and keyboard control, not CSS geometry;
// the populated panel is also measured in the source-backed demo at narrow desktop-pane widths.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import type { TurnExperiment } from "@intentic/sandbox-contract";
import MeasurementPanel from "./MeasurementPanel.vue";
import { tableOf } from "./experimentReadings";

const SETTLED: TurnExperiment = {
    metrics: [{ metric: `searchCalls`, on: { turns: 133, mean: 3.2 }, off: { turns: 40, mean: 6.4 }, deltaPct: -50, marginPct: 10 }],
    minTurns: 30,
};

// The map's first day under a restarted comparison: neither row has an answer, and the one before it had one.
const RESTARTED: TurnExperiment = {
    metrics: [
        { metric: `openedWithListing`, on: { turns: 29, mean: 0.3 }, off: { turns: 27, mean: 0.22 } },
        { metric: `callsBeforeTarget`, on: { turns: 16, mean: 84.1 }, off: { turns: 19, mean: 52.1 } },
    ],
    minTurns: 30,
    sampleUnit: `opening turns`,
    previous: {
        from: Date.UTC(2026, 8, 13, 12),
        to: Date.UTC(2026, 9, 6, 12),
        metrics: [{ metric: `openedWithListing`, on: { turns: 601, mean: 0.17 }, off: { turns: 165, mean: 0.31 }, deltaPct: -45.2, marginPct: 20.1 }],
    },
};

let app: App | undefined;
const mount = (populated: boolean | TurnExperiment = true, onCommit = jest.fn()): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const table = populated === false ? undefined : tableOf(populated === true ? SETTLED : populated);
    app = createApp({
        render: () =>
            h(MeasurementPanel, {
                table,
                percent: 10,
                note: `of turns run without search`,
                onLabel: `With search`,
                offLabel: `Without search`,
                onCommit,
            }),
    });
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`keeps a populated comparison in a named, keyboard-reachable local scroller with readable columns`, () => {
    const host = mount();
    const region = host.querySelector<HTMLElement>(`[role="region"]`)!;
    expect(region.getAttribute(`aria-label`)).toBe(`With search / Without search`);
    expect(region.tabIndex).toBe(0);
    expect(region.classList.contains(`overflow-x-auto`)).toBe(true);
    expect(region.classList.contains(`max-w-full`)).toBe(true);
    const table = region.querySelector(`table`)!;
    expect(table.classList.contains(`min-w-[32rem]`)).toBe(true);
    expect([...table.querySelectorAll(`thead th`)].map((cell) => cell.textContent)).toEqual([
        `Effect on the agent`,
        `With search`,
        `Without search`,
        `Change`,
    ]);
    expect(table.textContent).toContain(`3.2`);
    expect(table.textContent).toContain(`6.4`);
    expect(table.textContent).toContain(`50%`);
});

it(`keeps the comparison-share control outside the scroller and commits the same fraction`, async () => {
    const commit = jest.fn();
    const host = mount(true, commit);
    const input = host.querySelector<HTMLInputElement>(`input[type="number"]`)!;
    expect(input.closest(`[role="region"]`)).toBeNull();
    expect(input.getAttribute(`aria-label`)).toBe(`Comparison group, as a percentage`);
    input.value = `25`;
    input.dispatchEvent(new Event(`change`, { bubbles: true }));
    await nextTick();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(0.25);
});

it(`uses the empty-state sentence without an empty scrolling region`, () => {
    const host = mount(false);
    expect(host.querySelector(`[role="region"]`)).toBeNull();
    expect(host.querySelector(`table`)).toBeNull();
    expect(host.textContent).toContain(`No results yet`);
    expect(host.querySelector(`input[type="number"]`)).not.toBeNull();
});

const rowText = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`tbody tr`)].map((row) => [...row.children].map((cell) => cell.textContent?.trim() ?? ``).join(` | `));

it(`withholds an open row's averages and says how far along it is instead`, () => {
    const rows = rowText(mount(RESTARTED));
    expect(rows).toContain(`First turns that listed directories | – | – | Too early · 27 of 30`);
    expect(rows).toContain(`Tool calls before the right file | – | – | Too early · 16 of 30`);
    expect(rows.join(`\n`)).not.toContain(`84.1`);
});

it(`shows the last comparison that answered under a restarted one, its shares as percentages`, () => {
    const host = mount(RESTARTED);
    const rows = rowText(host);
    expect(rows).toContain(`Last result, Sep 13 – Oct 6`);
    expect(rows).toContain(`First turns that listed directories | 17% | 31% | ↓ 45% fewer`);
    expect(host.textContent).toContain(`A result shows once both groups have at least 30.`);
});

it(`drops the earlier comparison once the current one has an answer of its own`, () => {
    const host = mount({ ...SETTLED, previous: RESTARTED.previous });
    expect(host.textContent).not.toContain(`Last result`);
    expect(host.textContent).not.toContain(`A result shows once`);
});
