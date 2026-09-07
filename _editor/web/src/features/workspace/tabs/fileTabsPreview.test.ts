// @vitest-environment jsdom
//
// The italic tab is the ONLY thing on screen that says a tab is a peek: that the next file looked at will take
// its place. Nothing else in the strip distinguishes it, so if the italic stops being drawn the behaviour becomes
// tabs disappearing for no visible reason. Asserted here on the real strip, along with the gesture that ends it.
import { beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import FileTabs from "./FileTabs.vue";
import type { WorkspaceTab } from "./workspaceTabs";
import { IconStub } from "@intentic/ui/testing";

// The globals a mounted workspace component reads at import time; jsdom has none of them.
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

/* The whole class list, not a substring of it. `italic` is six characters that `not-italic` also contains, and
 * the slant is only readable because `pr-[0.2em]` gives the last glyph the room `truncate` would otherwise clip
 * (FileTabs.vue says the same beside the span). Pinning the list is what makes a restyle that drops either one
 * fail here instead of passing on a match inside some other utility. */
it(`draws the peeked tab in italic and leaves the kept ones upright`, async () => {
    preview.value = `src/peeked.ts`;

    await mountStrip();

    expect(labelOf(`peeked.ts`).className).toBe(`max-w-40 truncate pr-[0.2em] italic`);
    expect(labelOf(`kept.ts`).className).toBe(`max-w-40 truncate`);
});

// The italic says the tab is going away; the tooltip is the only room the strip has to say what stops that.
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
