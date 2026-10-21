// What a pane says about the answers it shows (@intentic/ui's FreshnessFrame, fed by reportFreshness): nothing for a
// routine poll or a quick refresh, a line along its top edge for a slow one, and the shown answer's age once that has
// gone on past a blip, a refresh failed, or the sandbox stopped answering.
import "@intentic/testing/dom";
import { FreshnessFrame, type ReadFreshness, reportFreshness } from "@intentic/ui";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 21, 12, 0, 0);

let app: App | undefined;
const facts = ref<ReadFreshness>({ shown: true, updatedAt: undefined, refreshingSince: undefined, refreshError: undefined });
const offline = ref(false);
const lostAt = ref<number | undefined>(undefined);

const Reader = defineComponent({
    setup() {
        reportFreshness(() => facts.value);
        return () => h(`div`, { "data-page": `` });
    },
});

const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(FreshnessFrame, { offline: offline.value, lostAt: lostAt.value }, { default: () => h(Reader) }) });
    app.mount(el);
    await nextTick();
    return el;
};
const settle = async (ms: number): Promise<void> => {
    jest.advanceTimersByTime(ms);
    await nextTick();
};
const line = (el: HTMLElement): boolean => el.querySelector(`.ui-freshness-sweep`) !== null;
const pill = (el: HTMLElement): string | undefined => el.querySelector(`[role="status"]`)?.textContent?.trim();

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    facts.value = { shown: true, updatedAt: undefined, refreshingSince: undefined, refreshError: undefined };
    offline.value = false;
    lostAt.value = undefined;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
});

it(`draws nothing for a refresh of an answer confirmed a moment ago, however long it takes`, async () => {
    facts.value = { ...facts.value, updatedAt: START - 2_000, refreshingSince: START };
    const el = await mount();
    await settle(10_000);
    expect(line(el)).toBe(false);
    expect(pill(el)).toBeUndefined();
});

it(`draws nothing for a quick refresh of an old answer`, async () => {
    facts.value = { ...facts.value, updatedAt: START - 5 * MINUTE, refreshingSince: START };
    const el = await mount();
    await settle(250);
    facts.value = { ...facts.value, updatedAt: Date.now(), refreshingSince: undefined };
    await settle(1_000);
    expect(line(el)).toBe(false);
    expect(pill(el)).toBeUndefined();
});

it(`draws the line for a slow refresh of an old answer, then says how old the answer is`, async () => {
    facts.value = { ...facts.value, updatedAt: START - 5 * MINUTE, refreshingSince: START };
    const el = await mount();
    await settle(600);
    expect(line(el)).toBe(true);
    expect(pill(el)).toBeUndefined();
    await settle(3_000);
    expect(pill(el)).toContain(`5`);
    facts.value = { ...facts.value, updatedAt: Date.now(), refreshingSince: undefined };
    await settle(1_000);
    expect(line(el)).toBe(false);
    expect(pill(el)).toBeUndefined();
});

it(`says how old an answer is once its refresh failed, without a line`, async () => {
    facts.value = { ...facts.value, updatedAt: START - 2 * 3_600_000, refreshError: `daemon unreachable` };
    const el = await mount();
    await settle(600);
    expect(line(el)).toBe(false);
    expect(pill(el)).toContain(`2`);
});

it(`says nothing for an answer under a minute old, even when its refresh failed`, async () => {
    facts.value = { ...facts.value, updatedAt: START - 20_000, refreshError: `daemon unreachable` };
    const el = await mount();
    await settle(600);
    expect(pill(el)).toBeUndefined();
});

it(`dates a silent sandbox's answers from when it stopped answering, and only past a blip`, async () => {
    facts.value = { ...facts.value, updatedAt: START - 3 * 3_600_000 };
    lostAt.value = START - 10 * MINUTE;
    offline.value = true;
    const el = await mount();
    await settle(1_000);
    expect(pill(el)).toBeUndefined();
    await settle(2_500);
    // Ten minutes and a few seconds since the drop, not three hours since the fetch.
    expect(pill(el)).toContain(`10`);
});
