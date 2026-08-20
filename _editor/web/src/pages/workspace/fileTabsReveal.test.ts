// @vitest-environment jsdom
//
// The tab strip is a SCROLL BOX, and almost nothing that focuses a tab is inside it: a row in the file tree, a
// Changes or Checkpoints row, a restored strip on reload. Once enough files are open, the tab those gestures
// open sits past the strip's right edge — the editor swapped its content while the strip kept showing tabs from
// elsewhere, which reads as a click that did nothing. jsdom lays nothing out, so what is asserted is the CALL:
// which tab the strip asked to reveal, and that it asked for the cheapest scroll (`nearest`, a no-op on a tab
// already visible, so clicking a tab never shifts it out from under the pointer).
import { beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import FileTabs from "./FileTabs.vue";
import type { WorkspaceTab } from "./workspaceTabs";

// The globals a mounted workspace component reads at import time, plus the one this file is about: jsdom
// implements no scrollIntoView at all, so it is installed as the recorder the assertions read.
const { reveals } = vi.hoisted(() => {
    const recorded: { tab: string; inline: string | undefined }[] = [];
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: boolean | ScrollIntoViewOptions): void {
        recorded.push({
            tab: this.textContent?.trim() ?? ``,
            inline: typeof options === `object` ? options.inline : undefined,
        });
    };
    return { reveals: recorded };
});

// Enough files to overflow any real strip, named so a reveal is identifiable by the label it drew.
const PATHS = Array.from({ length: 8 }, (_unused, at) => `src/file${at}.ts`);
const TABS: WorkspaceTab[] = PATHS.map((path) => ({ kind: `file`, id: path, path }));

const active = ref<string | null>(null);
let app: App | undefined;

const mountStrip = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(FileTabs, { tabs: TABS, active: active.value }) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.mount(el);
    await settle();
};

// The strip reveals on the tick AFTER the focus change, so the tab it reveals is one the DOM already holds.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

beforeEach(() => {
    app?.unmount();
    app = undefined;
    active.value = null;
    reveals.length = 0;
});

it(`scrolls a file focused from outside the strip into view`, async () => {
    await mountStrip();
    reveals.length = 0;

    // Clicking a file in the tree, on a strip scrolled nowhere near the tab it owns.
    active.value = PATHS[7]!;
    await settle();

    expect(reveals.at(-1)).toEqual({ tab: `file7.ts`, inline: `nearest` });
});

it(`opens already showing the focused file — the reload's first frame`, async () => {
    active.value = PATHS[6]!;

    await mountStrip(); // the strip coming back from its snapshot, focused on a tab far to the right

    expect(reveals.at(-1)).toEqual({ tab: `file6.ts`, inline: `nearest` });
});

it(`scrolls nowhere when the strip is focused on nothing`, async () => {
    await mountStrip(); // a bare /workspace: tabs open, none of them focused

    expect(reveals).toEqual([]);
});
