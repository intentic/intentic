// Pins EnvironmentContents' shape, not the inventory (contents.integration.test.ts has that): the decisions as chips whose
// card opens on a press, staples as plain names with nothing to press, attribution said once, several taken out at once.
import "@intentic/testing/dom";
import type { EnvironmentItem } from "@intentic/sandbox-contract/schemas/environment";
import PrimeVue from "primevue/config";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import type { ContentsGroup } from "./useEnvironmentContents";
import { IconStub } from "@intentic/ui/testing";

// The import chain touches browser globals at import time; stubbing fetch to fail mirrors an offline sandbox, so every
// mark paints its fallback tier.
(() => {
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof globalThis.fetch;
    // Nothing lays the page out here, so every element measures 0×0, which the opened card reads as its chip scrolled
    // away and closes on. A chip's size is all it measures.
    HTMLElement.prototype.getBoundingClientRect = (): DOMRect => DOMRect.fromRect({ x: 0, y: 0, width: 120, height: 32 });
})();

const { default: EnvironmentContents } = await import("./EnvironmentContents.vue");

const staple = (name: string, bin: string, version: string, purpose: string): EnvironmentItem => ({
    id: `base:${bin}`,
    name,
    origin: `base`,
    state: `active`,
    tools: [{ name: bin, version }],
    purpose,
});

// One of each origin: an agent-added item with a rationale, a capability-dragged item, and the base staples.
const GROUPS: ContentsGroup[] = [
    {
        origin: `custom`,
        label: `Added for this workspace`,
        items: [
            {
                id: `custom:ffmpeg`,
                name: `ffmpeg`,
                origin: `custom`,
                state: `active`,
                tools: [{ name: `ffmpeg`, version: `5.1.9` }],
                // The row's line trims the paragraph below it (drops the parenthetical), so it doesn't repeat when
                // expanded.
                purpose: `ffmpeg, encoding screen recordings.`,
                detail:
                    `ffmpeg, encoding screen recordings (Playwright records VP8/WebM). The recordings the machine agents ` +
                    `produce are raw frames until something encodes them.\n\nThe promo captures go out as MP4, which its ` +
                    `bundled build cannot encode.`,
                commands: `RUN apt-get install -y ffmpeg`,
                block: `ffmpeg`,
            },
            {
                id: `custom:sox`,
                name: `sox`,
                origin: `custom`,
                state: `awaiting-approval`,
                tools: [],
                purpose: `Trims the voice notes.`,
                block: `sox`,
            },
        ],
    },
    {
        origin: `capability`,
        label: `From your capabilities`,
        items: [
            {
                id: `capability:docker`,
                name: `docker`,
                origin: `capability`,
                originLabel: `docker capability`,
                state: `active`,
                tools: [{ name: `docker`, version: `29.7.2` }],
                purpose: `docker capability: this directive grants dockerd the privileges it needs.`,
            },
            {
                id: `capability:tauri`,
                name: `Rust tauri`,
                origin: `capability`,
                originLabel: `workspace extension`,
                state: `active`,
                tools: [{ name: `rustc`, version: `1.97.1` }],
                purpose: `The desktop app is a Tauri shell.`,
            },
        ],
    },
    {
        origin: `base`,
        label: `Comes with every sandbox`,
        items: [
            staple(`Node.js`, `node`, `24.18.0`, `The runtime everything JavaScript in here runs on.`),
            staple(`Python`, `python3`, `3.11.2`, `Scripting, plus anything reached for with pip.`),
            staple(`ripgrep`, `rg`, `13.0.0`, `Fast text search across the workspace.`),
        ],
    },
];

let app: App | undefined;
// What the list asked the card to take out, one entry per press.
let removed: string[][] = [];

const mount = (groups: ContentsGroup[] = GROUPS, removable = false): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    // Icon and v-tooltip are registered app-wide by installUi; stand-ins avoid pulling in the whole UI plugin.
    app = createApp({
        render: () =>
            h(EnvironmentContents, {
                loaded: { state: `ready`, data: groups, refreshing: false, refreshError: undefined },
                removable,
                onRemove: (items: EnvironmentItem[]) => removed.push(items.map((item) => item.name)),
            }),
    });
    app.component(`Icon`, IconStub);
    app.component(`RouterLink`, defineComponent({ props: { to: { type: String, default: `` } }, setup: (props, { slots }) => () => h(`a`, { href: props.to }, slots[`default`]?.()) }));
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    return el;
};

const chip = (el: HTMLElement, id: string): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`[data-environment-chip="${id}"]`)!;
// The opened card is teleported to <body>, off the list's own element.
const card = (): HTMLElement | null => document.querySelector<HTMLElement>(`[data-environment-card="open"]`);
const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
    [...root.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === name);

// Reads text per child, since the mark/name/version siblings have no whitespace between them in textContent.
const wordsOf = (element: Element): string =>
    [...element.children]
        .map((child) => child.textContent?.trim() ?? ``)
        .filter((text) => text !== ``)
        .join(` `);

afterEach(() => {
    app?.unmount();
    app = undefined;
    removed = [];
    document.body.innerHTML = ``;
});

it(`lists the staples as names and versions with nothing to press`, () => {
    const el = mount();
    const staples = el.querySelector(`[data-environment-staples]`)!;
    expect([...staples.querySelectorAll(`li`)].map(wordsOf)).toEqual([`Node.js 24.18.0`, `Python 3.11.2`, `ripgrep 13.0.0`]);
    expect(staples.querySelector(`button`)).toBeNull();
    expect(document.body.textContent).not.toContain(`The runtime everything JavaScript in here runs on.`);
});

it(`draws each decision as a chip of its name and version, its sentence left to the card`, () => {
    const el = mount();
    expect(wordsOf(chip(el, `custom:ffmpeg`))).toBe(`ffmpeg 5.1.9`);
    expect(document.body.textContent).not.toContain(`encoding screen recordings`);
    // A state other than live is a glyph on the chip, named for a reader who cannot see it.
    expect(chip(el, `custom:sox`).textContent).toContain(`waiting for your approval`);
});

it(`opens the whole block on a press, the rest of its comment one more click away`, async () => {
    const el = mount();
    chip(el, `custom:ffmpeg`).click();
    await nextTick();
    expect(chip(el, `custom:ffmpeg`).getAttribute(`aria-expanded`)).toBe(`true`);
    expect(card()?.textContent).toContain(`raw frames until something encodes them`);
    expect(card()?.textContent).toContain(`RUN apt-get install -y ffmpeg`);
    expect(card()?.textContent).not.toContain(`go out as MP4`);

    buttonNamed(card()!, `Show more`)!.click();
    await nextTick();
    expect(card()?.textContent).toContain(`go out as MP4`);
});

it(`never shows the opening sentence twice`, async () => {
    const el = mount();
    chip(el, `custom:ffmpeg`).click();
    await nextTick();
    expect(document.body.textContent?.match(/encoding screen recordings/g)).toHaveLength(1);
});

it(`only names the source when it is not already saying the block's own name`, async () => {
    const el = mount();
    // The card's properties, not its sentence: an agent's comment may say anything.
    const properties = (): string => card()?.querySelector(`dl`)?.textContent ?? ``;
    chip(el, `capability:docker`).click();
    await nextTick();
    expect(properties()).toContain(`29.7.2`);
    expect(properties()).not.toContain(`docker capability`);
    chip(el, `capability:tauri`).click();
    await nextTick();
    expect(properties()).toContain(`workspace extension`);
});

// One block goes from its own card; a capability's has no Remove, and says where its capability is turned off instead.
it(`offers Remove on an agent-added block only, and points a capability's at Capabilities`, async () => {
    const el = mount(GROUPS, true);
    chip(el, `capability:docker`).click();
    await nextTick();
    expect(buttonNamed(card()!, `Remove from environment`)).toBeUndefined();
    expect(card()?.querySelector(`a`)?.getAttribute(`href`)).toBe(`/capabilities`);

    chip(el, `custom:ffmpeg`).click();
    await nextTick();
    buttonNamed(card()!, `Remove from environment`)!.click();
    await nextTick();
    expect(removed).toEqual([[`ffmpeg`]]);
    expect(card()).toBeNull();
});

it(`takes several out at once once asked to select, ticking only what can go`, async () => {
    expect(buttonNamed(mount(GROUPS, false), `Select`)).toBeUndefined();
    app?.unmount();
    document.body.innerHTML = ``;

    const el = mount(GROUPS, true);
    buttonNamed(el, `Select`)!.click();
    await nextTick();
    expect(chip(el, `capability:docker`).disabled).toBe(true);
    expect(buttonNamed(el, `Remove`)!.disabled).toBe(true);

    chip(el, `custom:ffmpeg`).click();
    chip(el, `custom:sox`).click();
    await nextTick();
    expect(chip(el, `custom:ffmpeg`).getAttribute(`aria-checked`)).toBe(`true`);
    expect(card()).toBeNull();
    buttonNamed(el, `Remove 2`)!.click();
    expect(removed).toEqual([[`ffmpeg`, `sox`]]);

    buttonNamed(el, `Cancel`)!.click();
    await nextTick();
    expect(chip(el, `custom:ffmpeg`).getAttribute(`role`)).toBeNull();
});

// Mounted with a waiting read directly rather than through the parent, since the prop is the state under test.
const mountLoading = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(EnvironmentContents, { loaded: { state: `waiting`, since: Date.now(), retry: undefined } }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

it(`draws the list's outline while it is checking installed versions`, async () => {
    jest.useFakeTimers();
    try {
        const el = mountLoading();
        jest.advanceTimersByTime(250);
        await nextTick();
        expect(el.querySelectorAll(`.skeleton`).length).toBeGreaterThan(0);
        expect(el.querySelector(`[role="status"]`)?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    } finally {
        jest.useRealTimers();
    }
});

it(`paints no outline for a probe that answers within the reveal delay`, async () => {
    jest.useFakeTimers();
    try {
        const el = mountLoading();
        jest.advanceTimersByTime(150);
        await nextTick();
        expect(el.querySelector(`.skeleton`)).toBeNull();
    } finally {
        jest.useRealTimers();
    }
});

it(`draws no outline once the versions are in`, () => {
    expect(mount().querySelector(`.skeleton`)).toBeNull();
});
