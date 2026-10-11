// jsdom pins the table's bounded-scroll contract and keyboard control, not CSS geometry;
// the populated panel is also measured in the source-backed demo at narrow desktop-pane widths.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import MeasurementPanel from "./MeasurementPanel.vue";
import { tableOf } from "./experimentReadings";

let app: App | undefined;
const mount = (populated = true, onCommit = jest.fn()): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const table = populated
        ? tableOf({
              metrics: [{ metric: `searchCalls`, on: { turns: 133, mean: 3.2 }, off: { turns: 40, mean: 6.4 }, deltaPct: -50, marginPct: 10 }],
              minTurns: 30,
          })
        : undefined;
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
