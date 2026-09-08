// @vitest-environment jsdom
// Pins EnvironmentContents' shape, not the inventory (contents.integration.test.ts has that): staples as a scannable
// strip, a closed row costing one line, attribution said once.
import type { EnvironmentItem } from "@intentic/api-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { ContentsGroup } from "./useEnvironmentContents";
import { IconStub } from "@intentic/ui/testing";

// The import chain touches browser globals at import time; stubbing fetch to fail mirrors an offline sandbox, so every
// mark paints its fallback tier.
vi.hoisted(() => {
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof globalThis.fetch;
    // jsdom ships no ResizeObserver; nothing in this suite depends on measured width.
});

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

const mount = (groups: ContentsGroup[] = GROUPS): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    // Icon and v-tooltip are registered app-wide by installUi; stand-ins avoid pulling in the whole UI plugin.
    app = createApp({ render: () => h(EnvironmentContents, { groups, loading: false }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

// Every pill in the staples strip; row-disclosure headers (`aria-expanded`) are excluded.
const pills = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll<HTMLButtonElement>(`button[type="button"]`)].filter((button) => !button.hasAttribute(`aria-expanded`));

// The row's own disclosure toggle: the pressable header button, marked by `aria-expanded`.
const disclosure = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(`button[aria-expanded]`)!;

// Reads text per child, since the mark/name/version siblings have no whitespace between them in textContent.
const wordsOf = (element: Element): string =>
    [...element.children]
        .map((child) => child.textContent?.trim() ?? ``)
        .filter((text) => text !== ``)
        .join(` `);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`draws the staples as a strip whose sentences are one click away`, async () => {
    const el = mount();
    expect(pills(el).map(wordsOf)).toEqual([`Node.js 24.18.0`, `Python 3.11.2`, `ripgrep 13.0.0`]);
    expect(el.textContent).not.toContain(`The runtime everything JavaScript in here runs on.`);

    pills(el)[0]!.click();
    await nextTick();
    expect(el.textContent).toContain(`The runtime everything JavaScript in here runs on.`);

    pills(el)[1]!.click();
    await nextTick();
    expect(el.textContent).not.toContain(`The runtime everything JavaScript in here runs on.`);
    expect(el.textContent).toContain(`Scripting, plus anything reached for with pip.`);
});

it(`keeps a closed row to its one line, and opens the comment in place`, async () => {
    const el = mount();
    const row = disclosure(el);
    expect(el.textContent).toContain(`ffmpeg, encoding screen recordings.`);
    expect(el.textContent).not.toContain(`raw frames until something encodes them`);

    row.click();
    await nextTick();
    expect(el.textContent).toContain(`raw frames until something encodes them`);
    expect(el.textContent).toContain(`RUN apt-get install -y ffmpeg`);
});

it(`never shows the opening sentence twice`, async () => {
    const el = mount();
    disclosure(el).click();
    await nextTick();
    expect(el.textContent?.match(/encoding screen recordings/g)).toHaveLength(1);
});

it(`opens on the first paragraph and keeps the rest one click away`, async () => {
    const el = mount();
    const row = disclosure(el);
    row.click();
    await nextTick();
    expect(el.textContent).not.toContain(`go out as MP4`);

    const more = [...el.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Show more`));
    more!.click();
    await nextTick();
    expect(el.textContent).toContain(`go out as MP4`);
    expect(el.textContent).toContain(`RUN apt-get install -y ffmpeg`);
});

it(`only names the source when it is not already saying the row's own name`, () => {
    const el = mount();
    // `.tabular-nums`: the trailing facts cluster, where a row states what pulled it in.
    const facts = [...el.querySelectorAll(`.tabular-nums`)].map((meta) => meta.textContent?.trim() ?? ``).join(` `);
    expect(facts).not.toContain(`docker capability`);
    expect(facts).toContain(`workspace extension`);
});

// Mounted with `loading` directly rather than through the parent, since the prop is the state under test.
const mountLoading = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(EnvironmentContents, { groups: [], loading: true }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

it(`draws the list's outline while it is checking installed versions`, async () => {
    vi.useFakeTimers();
    try {
        const el = mountLoading();
        vi.advanceTimersByTime(250);
        await nextTick();
        expect(el.querySelectorAll(`.skeleton`).length).toBeGreaterThan(0);
        expect(el.querySelector(`[role="status"]`)?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    } finally {
        vi.useRealTimers();
    }
});

it(`paints no outline for a probe that answers within the reveal delay`, async () => {
    vi.useFakeTimers();
    try {
        const el = mountLoading();
        vi.advanceTimersByTime(150);
        await nextTick();
        expect(el.querySelector(`.skeleton`)).toBeNull();
    } finally {
        vi.useRealTimers();
    }
});

it(`draws no outline once the versions are in`, () => {
    expect(mount().querySelector(`.skeleton`)).toBeNull();
});
