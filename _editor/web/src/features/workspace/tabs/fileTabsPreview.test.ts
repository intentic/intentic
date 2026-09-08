// @vitest-environment jsdom
// Pins the peeked tab's only visual signal, italic, and the double-click that promotes it, asserted on the real
// rendered strip.
import { beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import FileTabs from "./FileTabs.vue";
import type { WorkspaceTab } from "./workspaceTabs";
import { IconStub } from "@intentic/ui/testing";

// scrollIntoView: FileTabs reads it at import; jsdom doesn't implement it.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

const TABS: WorkspaceTab[] = [
    { kind: `file`, id: `src/kept.ts`, path: `src/kept.ts` },
    { kind: `file`, id: `src/peeked.ts`, path: `src/peeked.ts` },
];

const preview = ref<string | null>(null);
const kept: string[] = [];
let app: App | undefined;
let root: HTMLElement;

const mountStrip = async (): Promise<void> => {
    root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({
        render: () => h(FileTabs, { tabs: TABS, active: `src/peeked.ts`, preview: preview.value, onKeep: (id: string) => kept.push(id) }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {
        mounted(el: HTMLElement, binding: { value?: unknown }): void {
            el.setAttribute(`data-tooltip`, String(binding.value));
        },
    });
    app.mount(root);
    await nextTick();
    await nextTick();
};

// The tab drawing a given basename, by the label it painted.
const tabFor = (name: string): HTMLElement => [...root.querySelectorAll(`[data-tab]`)].find((tab) => tab.textContent?.trim() === name) as HTMLElement;
const labelOf = (name: string): HTMLElement => tabFor(name).querySelector(`span`) as HTMLElement;

beforeEach(() => {
    app?.unmount();
    app = undefined;
    preview.value = null;
    kept.length = 0;
});

// Checks the whole class list, not a substring: `not-italic` contains `italic`, so a substring match would pass
// a dropped class silently.
it(`draws the peeked tab in italic and leaves the kept ones upright`, async () => {
    preview.value = `src/peeked.ts`;

    await mountStrip();

    expect(labelOf(`peeked.ts`).className).toBe(`max-w-40 truncate pr-[0.2em] italic`);
    expect(labelOf(`kept.ts`).className).toBe(`max-w-40 truncate`);
});

it(`tells the reader how to keep the tab it is about to replace`, async () => {
    preview.value = `src/peeked.ts`;

    await mountStrip();

    const peeked = tabFor(`peeked.ts`);
    const keptTab = tabFor(`kept.ts`);
    expect(peeked.getAttribute(`data-tooltip`)).not.toBe(keptTab.getAttribute(`data-tooltip`));
    expect(peeked.getAttribute(`data-tooltip`)).not.toBe(`src/peeked.ts`);
    expect(keptTab.getAttribute(`data-tooltip`)).toBe(`src/kept.ts`);
});

it(`asks to keep the tab that was double-clicked`, async () => {
    preview.value = `src/peeked.ts`;
    await mountStrip();

    tabFor(`peeked.ts`).dispatchEvent(new MouseEvent(`dblclick`, { bubbles: true }));

    expect(kept).toEqual([`src/peeked.ts`]);
});

it(`draws every tab upright when nothing is being peeked at`, async () => {
    await mountStrip();

    expect(labelOf(`peeked.ts`).className).toBe(`max-w-40 truncate`);
});
