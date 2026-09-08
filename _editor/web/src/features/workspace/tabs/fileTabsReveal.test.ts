// @vitest-environment jsdom
// Pins that focusing a tab from outside the strip (tree, Changes, reload) scrolls it into view. jsdom lays nothing
// out, so assertions check the scrollIntoView call (target + `nearest`), not actual position.
import { beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import FileTabs from "./FileTabs.vue";
import type { WorkspaceTab } from "./workspaceTabs";
import { IconStub } from "@intentic/ui/testing";

// scrollIntoView is stubbed as a recorder; jsdom implements none, and assertions read what it captured.
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

// Enough files to overflow any real strip; named so a reveal is identifiable by the label it drew.
const PATHS = Array.from({ length: 8 }, (_unused, at) => `src/file${at}.ts`);
const TABS: WorkspaceTab[] = PATHS.map((path) => ({ kind: `file`, id: path, path }));

const active = ref<string | null>(null);
let app: App | undefined;

const mountStrip = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(FileTabs, { tabs: TABS, active: active.value }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await settle();
};

// Strip reveals a tick after the focus change, once the DOM already holds the new tab.
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

    // Simulates a click in the file tree, on a tab far from the strip's current scroll position.
    active.value = PATHS[7]!;
    await settle();

    expect(reveals.at(-1)).toEqual({ tab: `file7.ts`, inline: `nearest` });
});

it(`opens already showing the focused file: the reload's first frame`, async () => {
    active.value = PATHS[6]!;

    await mountStrip(); // Mounts pre-focused, as a reload restoring its snapshot would (tab far to the right).

    expect(reveals.at(-1)).toEqual({ tab: `file6.ts`, inline: `nearest` });
});

it(`scrolls nowhere when the strip is focused on nothing`, async () => {
    await mountStrip();

    expect(reveals).toEqual([]);
});
