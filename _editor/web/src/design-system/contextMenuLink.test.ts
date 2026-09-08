// @vitest-environment jsdom
import { ContextMenu } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// A menu row that goes somewhere must be a real link: pinned here since @intentic/ui has no test runner and the
// breaking surfaces (file tree menu, terminal pill bar, chat tab strip, capability row) live in this app.
// PrimeVue's click handler sits on the row's wrapper, not the anchor, so the address must be on the anchor and the
// command must stand down when the browser has taken the click.

const item = (over: Partial<MenuItem> = {}): MenuItem => ({ label: `Sandbox settings`, url: `/sandbox`, ...over });

let app: ReturnType<typeof createApp> | undefined;

// The menu teleports out of the component, so its rows are found on the document rather than on the mount.
const mountMenu = async (model: MenuItem[]): Promise<void> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const menu = ref<{ show: (event: Event) => void } | undefined>();
    app = createApp(defineComponent({ setup: () => () => h(ContextMenu, { ref: menu, model }) }));
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
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
    // The command navigates in-app; letting the anchor through too would reload the whole application.
    expect(event.defaultPrevented).toBe(true);
});

it(`hands a modified click to the browser and holds the command back`, async () => {
    const command = vi.fn();
    await mountMenu([item({ command })]);

    const event = new MouseEvent(`click`, { bubbles: true, cancelable: true, ctrlKey: true });
    rowNamed(`Sandbox settings`).dispatchEvent(event);
    await nextTick();

    // A tab is opening elsewhere; running the command too would move this tab underneath it.
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
