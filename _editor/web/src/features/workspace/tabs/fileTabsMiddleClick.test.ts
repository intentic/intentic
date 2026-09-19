// @vitest-environment jsdom
// Middle-click closes the tab it lands on, asserted on the real rendered strip: the press has to reach the pill
// from wherever inside it the pointer was, and must not select on the way out.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import FileTabs from "./FileTabs.vue";
import type { WorkspaceTab } from "./workspaceTabs";
import { IconStub } from "@intentic/ui/testing";

// scrollIntoView: FileTabs reads it at import; jsdom doesn't implement it.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

const TABS: WorkspaceTab[] = [
    { kind: `file`, id: `src/kept.ts`, path: `src/kept.ts` },
    { kind: `file`, id: `src/closing.ts`, path: `src/closing.ts` },
];

let app: App | undefined;

const mountStrip = async () => {
    const closed: string[] = [];
    const selected: string[] = [];
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({
        render: () =>
            h(FileTabs, {
                tabs: TABS,
                active: `src/kept.ts`,
                onClose: (id: string) => closed.push(id),
                onSelect: (id: string) => selected.push(id),
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(root);
    await nextTick();
    await nextTick();
    return { root, closed, selected };
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

// The tab drawing a given basename, by the label it painted.
const tabFor = (root: HTMLElement, name: string): HTMLElement =>
    [...root.querySelectorAll(`[data-tab]`)].find((tab) => tab.textContent?.trim() === name) as HTMLElement;

const press = (el: HTMLElement, button: number): void => {
    el.dispatchEvent(new MouseEvent(`auxclick`, { bubbles: true, cancelable: true, button }));
};

it(`closes the tab a middle-click lands on, without selecting it on the way`, async () => {
    const { root, closed, selected } = await mountStrip();

    press(tabFor(root, `closing.ts`), 1);
    await nextTick();

    expect(closed).toEqual([`src/closing.ts`]);
    expect(selected).toEqual([]);
});

// The × is a hit target inside the pill; a middle press that lands on it closes the same tab once, not twice.
it(`closes once from the × inside the tab`, async () => {
    const { root, closed } = await mountStrip();

    press(tabFor(root, `closing.ts`).querySelector(`span:last-of-type`) as HTMLElement, 1);
    await nextTick();

    expect(closed).toEqual([`src/closing.ts`]);
});

// The other buttons keep their own meanings: right opens the strip's menu, left selects.
it(`leaves the tab open for the other buttons`, async () => {
    const { root, closed } = await mountStrip();

    press(tabFor(root, `closing.ts`), 2);
    await nextTick();

    expect(closed).toEqual([]);
});
