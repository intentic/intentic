// @vitest-environment jsdom
//
// jsdom because the subject is A CLAIM THIS TAB MAKES ABOUT THE WORLD, and the bug was that it made it too early.
// "Nothing running: open a panel from the sidebar" and "the lists have not arrived" are the same two empty
// arrays, so a cold cache told every reader their dev servers were down on the one tab whose entire job is
// saying what is up. None of that is visible in the derivation (useRunning is correct either way): it is only
// visible in what the component PUTS ON SCREEN at each moment of the read, which is why this mounts it.
import type { CapabilitySummary, PanelSummary } from "@intentic-app/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// What this component's import chain reads at module eval: the same edge SandboxDevices.test.ts cuts.

const panels = ref<PanelSummary[]>([]);
const capabilities = ref<CapabilitySummary[]>([]);
const panelsLoading = ref(true);
const capabilitiesLoading = ref(true);
vi.mock(`../../composables/extensions/usePanels`, () => ({
    usePanels: () => ({ panels, isLoading: panelsLoading }),
}));
vi.mock(`../../composables/extensions/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities, isLoading: capabilitiesLoading }),
}));
// The VPN card above the list is its own surface with its own daemon call; this mounts the list and nothing else.
vi.mock(`../../components/VpnCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: SandboxStatus } = await import("./SandboxStatus.vue");

// The real composable over the mocked queries above, so "what counts as running" is decided the way it is in the
// app rather than by this file's idea of it.
const runningPanel = (repo: string): PanelSummary => ({ repo, running: true, healthy: true, port: 5173 }) as unknown as PanelSummary;

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxStatus) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    // A running panel's title links to whatever serves it; there is no router here and the link's target is not
    // this file's subject, so it renders as its text.
    app.component(
        `RouterLink`,
        defineComponent({
            props: { to: [String, Object] },
            setup:
                (_, { slots }) =>
                () =>
                    h(`a`, slots[`default`]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

beforeEach(() => {
    vi.useFakeTimers();
    panels.value = [];
    capabilities.value = [];
    panelsLoading.value = true;
    capabilitiesLoading.value = true;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    vi.useRealTimers();
});

// THE BUG. Both reads are out, both lists are therefore empty, and the tab must say nothing about it.
it(`does not claim nothing is running while the lists are still being read`, async () => {
    const el = mount();
    await nextTick();
    expect(el.textContent).not.toContain(`Nothing running`);
});

/* The reveal gate, from the quiet side: a daemon that answers inside the delay must paint no placeholder at all.
 * A skeleton that appears for 80ms is read as a fault, and this hub has eleven tabs to do it on. */
it(`paints no outline at all for an answer that lands within the reveal delay`, async () => {
    const el = mount();
    vi.advanceTimersByTime(150);
    panelsLoading.value = false;
    capabilitiesLoading.value = false;
    panels.value = [runningPanel(`api`)];
    await nextTick();
    expect(el.querySelector(`.skeleton`)).toBeNull();
    expect(el.textContent).toContain(`api`);
});

// Past the delay the wait is worth showing, and what is shown is the shape of the list: with the sentence a
// screen reader gets instead of the bars.
it(`draws the list's outline once the wait is long enough to be worth showing`, async () => {
    const el = mount();
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(el.querySelectorAll(`.skeleton`).length).toBeGreaterThan(0);
    expect(el.querySelector(`[role="status"]`)?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // The bars are decoration; the region carries the announcement, so the rows themselves are hidden from it.
    expect(el.querySelector(`.skeleton`)?.closest(`[aria-hidden="true"]`)).not.toBeNull();
});

/* Both reads, not either: the list spans dev servers and services, so one landing alone still leaves half the
 * answer missing, and the empty state would then be as wrong as it ever was. */
it(`keeps waiting when only one of the two reads has landed`, async () => {
    const el = mount();
    vi.advanceTimersByTime(250);
    panelsLoading.value = false;
    await nextTick();
    expect(el.textContent).not.toContain(`Nothing running`);
    expect(el.querySelectorAll(`.skeleton`).length).toBeGreaterThan(0);
});

// When id and kind are the same word (docker/docker), the subtitle would repeat the title for no reason.
it(`does not repeat the kind when it matches the id`, async () => {
    const el = mount();
    capabilitiesLoading.value = false;
    panelsLoading.value = false;
    capabilities.value = [{ id: `docker`, kind: `docker`, status: { state: `active` }, config: {} } as CapabilitySummary];
    await nextTick();
    expect(el.textContent?.match(/docker/g)?.length).toBe(1);
});

// And once it is true, it is said: the empty state is not lost, only deferred until it is honest.
it(`says nothing is running once both reads land empty`, async () => {
    const el = mount();
    vi.advanceTimersByTime(250);
    panelsLoading.value = false;
    capabilitiesLoading.value = false;
    await nextTick();
    // Past the minimum hold, so the outline has been allowed to drop.
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(el.querySelector(`.skeleton`)).toBeNull();
    expect(el.textContent).toContain(`Nothing running`);
});
