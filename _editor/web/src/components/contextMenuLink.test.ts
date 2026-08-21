// @vitest-environment jsdom
import { ContextMenu } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

/* A MENU ROW THAT GOES SOMEWHERE IS A LINK, and this is the file that keeps it one.
 *
 * Pinned here rather than beside the component because @intentic/ui carries no test runner, and every surface
 * that would break lives in this app: the file tree's menu, the terminal pill bar's, the chat tab strip's, the
 * capability row's "Connect / disconnect".
 *
 * PrimeVue's own markup is the reason this can regress silently. Its click handler sits on the row's WRAPPER,
 * not on the anchor inside it, so the natural way to write this (an `<a href>` and nothing else) yields a row
 * where a Ctrl/⌘-click opens a tab AND runs the command that navigates the tab you were reading. Both halves
 * below are that bug: the address has to be on the anchor, and the command has to stand down when the browser
 * has taken the click.
 */

const item = (over: Partial<MenuItem> = {}): MenuItem => ({ label: `Sandbox settings`, url: `/sandbox`, ...over });

let app: ReturnType<typeof createApp> | undefined;

// The menu teleports out of the component, so its rows are found on the document rather than on the mount.
const mountMenu = async (model: MenuItem[]): Promise<void> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const menu = ref<{ show: (event: Event) => void } | undefined>();
    app = createApp(defineComponent({ setup: () => () => h(ContextMenu, { ref: menu, model }) }));
    app.use(PrimeVue);
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.mount(host);
    menu.value?.show(new MouseEvent(`contextmenu`, { bubbles: true }));
    await nextTick();
    await nextTick();
};

const rowNamed = (label: string): HTMLAnchorElement => [...document.querySelectorAll(`a`)].find((link) => (link.textContent ?? ``).includes(label))!;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`carries the destination's real address, so the browser can act on it`, async () => {
    await mountMenu([item()]);

    expect(rowNamed(`Sandbox settings`).getAttribute(`href`)).toBe(`/sandbox`);
});

it(`lets the command own a plain click, without the anchor also loading the page`, async () => {
    const command = vi.fn();
    await mountMenu([item({ command })]);

    const event = new MouseEvent(`click`, { bubbles: true, cancelable: true });
    rowNamed(`Sandbox settings`).dispatchEvent(event);
    await nextTick();

    expect(command).toHaveBeenCalledTimes(1);
    // The command navigates in-app; letting the anchor through as well would reload the whole application.
    expect(event.defaultPrevented).toBe(true);
});

it(`hands a modified click to the browser and holds the command back`, async () => {
    const command = vi.fn();
    await mountMenu([item({ command })]);

    const event = new MouseEvent(`click`, { bubbles: true, cancelable: true, ctrlKey: true });
    rowNamed(`Sandbox settings`).dispatchEvent(event);
    await nextTick();

    // A tab is opening elsewhere. Running the command too would move THIS tab underneath it, which is the
    // whole failure: the row would both open the page and leave the one you were reading.
    expect(command).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
});

it(`leaves an ordinary command row alone: no address, and the click still runs it`, async () => {
    const command = vi.fn();
    await mountMenu([{ label: `Rename`, command }]);

    const row = rowNamed(`Rename`);
    expect(row.getAttribute(`href`)).toBeNull();

    const event = new MouseEvent(`click`, { bubbles: true, cancelable: true });
    row.dispatchEvent(event);
    await nextTick();

    expect(command).toHaveBeenCalledTimes(1);
});
