// Gesture wiring and menu rows only: selection, labels and the kill question are pinned in panel/*.test.ts.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { commands } from "../../../shell/commands/useCommands";
import { setTerminalMeta, terminalMeta } from "../terminalMeta";
import TerminalStrip from "./TerminalStrip.vue";
import type { TerminalTab } from "../useTerminal";

const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;
// Labelled after their names, so a pill is found by what it says.
const shell = (name: string, over: Partial<TerminalTab> = {}): TerminalTab => ({
    name,
    label: name,
    kind: `shell`,
    running: true,
    activityAt: minutesAgo(0),
    ...over,
});

const mounted: App[] = [];
afterEach(async () => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
    document.body.replaceChildren();
    // PrimeVue's tooltip and overlays schedule their own removal on a zero-delay timer; run it while a document exists.
    await new Promise((resolve) => setTimeout(resolve));
    for (const name of [`a`, `b`, `c`, `d`]) {
        setTerminalMeta(name, { label: undefined, color: undefined, icon: undefined });
    }
});

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

const stage = async (over: { readOnly?: boolean; groups?: string[][]; order?: TerminalTab[] } = {}) => {
    const layout = ref(over.groups ?? [[`a`], [`b`, `c`], [`d`]]);
    const tabs = {
        order: ref(over.order ?? [shell(`a`), shell(`b`), shell(`c`), shell(`d`)]),
        groups: computed(() => layout.value),
        answer: ref<`waiting` | `arrived` | `refused`>(`arrived`),
        remembered: computed(() => []),
        activeName: ref<string | undefined>(`a`),
        switchTab: jest.fn((_name: string) => undefined),
        joinTabs: jest.fn((_names: string[]) => undefined),
        unsplit: jest.fn((_name: string) => undefined),
        newTab: jest.fn(),
        splitTab: over.readOnly === true ? undefined : jest.fn((_name: string) => undefined),
        killTabs: over.readOnly === true ? undefined : jest.fn((_names: string[]) => undefined),
    };
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({
        render: () => h(TerminalStrip, { tabs, floating: { floats: computed(() => false), toggle: jest.fn() }, vertical: false }),
    });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    mounted.push(app);
    await settle();
    return { tabs, host };
};

const pill = (host: HTMLElement, label: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>(`[data-term-tab] > div`)].find((segment) => segment.textContent?.trim().startsWith(label))!;
const press = async (el: Element, type: string, init: MouseEventInit = {}): Promise<void> => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    await settle();
};
// The open menu's rows in order, a separator as `—`, wherever PrimeVue drew its overlay.
const menuRows = (): string[] =>
    [...document.querySelectorAll(`[role="menuitem"], [role="separator"]`)].map((row) =>
        row.getAttribute(`role`) === `separator` ? `—` : (row.getAttribute(`aria-label`) ?? ``),
    );
const pressRow = async (label: string): Promise<void> => {
    document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${label}"] a`)!.click();
    await settle();
};
const runCommand = (id: string): void => void commands.value.find((entry) => entry.command === id)?.handler();

describe(`pressing a pill`, () => {
    it(`switches on a plain press, and only selects under Shift or Ctrl`, async () => {
        const { tabs, host } = await stage();
        await press(pill(host, `d`), `click`, { shiftKey: true });
        await press(pill(host, `b`), `click`, { ctrlKey: true });
        expect(tabs.switchTab).not.toHaveBeenCalled();
        runCommand(`terminal.join`);
        expect(tabs.joinTabs.mock.calls).toEqual([[[`a`, `d`]]]);

        await press(pill(host, `d`), `click`);
        expect(tabs.switchTab.mock.calls).toEqual([[`d`]]);
    });

    it(`never kills a pill being renamed on a middle-click`, async () => {
        const { tabs, host } = await stage();
        const renamed = pill(host, `a`);
        await press(renamed, `dblclick`);
        await press(renamed, `auxclick`, { button: 1 });
        expect(tabs.killTabs).not.toHaveBeenCalled();
    });
});

describe(`renaming and restyling`, () => {
    const field = (host: HTMLElement): HTMLInputElement | null => host.querySelector<HTMLInputElement>(`input`);
    const type = async (host: HTMLElement, text: string, key: string): Promise<void> => {
        const input = field(host)!;
        input.value = text;
        input.dispatchEvent(new Event(`input`));
        input.dispatchEvent(new KeyboardEvent(`keydown`, { key, bubbles: true }));
        await settle();
    };

    it(`commits trimmed, and resets on an empty name`, async () => {
        const { host } = await stage();
        await press(pill(host, `a`), `dblclick`);
        await type(host, `  api  `, `Enter`);
        expect(terminalMeta(`a`).label).toBe(`api`);

        await press(pill(host, `api`), `dblclick`);
        expect(field(host)?.value).toBe(`api`);
        await type(host, ``, `Enter`);
        expect(terminalMeta(`a`).label).toBe(undefined);
    });

    it(`leaves the name alone when the edit is cancelled`, async () => {
        const { host } = await stage();
        await press(pill(host, `a`), `dblclick`);
        await type(host, `api`, `Escape`);
        expect({ label: terminalMeta(`a`).label, editing: field(host) }).toEqual({ label: undefined, editing: null });
    });

    it(`applies a picked colour or icon and closes the picker`, async () => {
        const { host } = await stage();
        await press(pill(host, `a`), `contextmenu`);
        await pressRow(`Change color…`);
        document.querySelector<HTMLElement>(`[aria-label="cyan"]`)!.click();
        await press(pill(host, `a`), `contextmenu`);
        await pressRow(`Change icon…`);
        document.querySelector<HTMLElement>(`[aria-label="star"]`)!.click();
        await settle();
        expect(terminalMeta(`a`)).toEqual({ color: `cyan`, icon: `star` });
    });
});

describe(`the context menus`, () => {
    it(`offers a single pill split, unsplit where it is in a group, restyling, and its kill, then the strip's rows`, async () => {
        const { host } = await stage();
        await press(pill(host, `b`), `contextmenu`);
        expect(menuRows()).toEqual([
            `Split terminal`,
            `Unsplit terminal`,
            `—`,
            `Rename`,
            `Change color…`,
            `Change icon…`,
            `—`,
            `Kill terminal`,
            `Kill all terminals`,
            `—`,
            `Show work terminals`,
            `Move panel into new window`,
        ]);
    });

    it(`offers mass actions for a selection spanning groups, and joins it`, async () => {
        const { tabs, host } = await stage();
        await press(pill(host, `b`), `click`, { shiftKey: true });
        await press(pill(host, `b`), `contextmenu`);
        expect(menuRows().slice(0, 3)).toEqual([`Join 2 tabs`, `—`, `Kill 3 terminals`]);
        await pressRow(`Join 2 tabs`);
        expect(tabs.joinTabs.mock.calls).toEqual([[[`a`, `b`, `c`]]]);
    });

    it(`opens the strip-wide rows alone on empty bar space`, async () => {
        const { host } = await stage({ order: [shell(`a`), shell(`b`, { activityAt: minutesAgo(30) })], groups: [[`a`], [`b`]] });
        await press(host.firstElementChild!, `contextmenu`);
        expect(menuRows()).toEqual([`Kill 1 inactive terminal`, `Kill all terminals`, `—`, `Show work terminals`, `Move panel into new window`]);
    });

    it(`offers and does no kill on a read-only strip`, async () => {
        const { host } = await stage({ readOnly: true });
        await press(pill(host, `a`), `auxclick`, { button: 1 });
        runCommand(`terminal.killInactive`);
        await press(pill(host, `a`), `contextmenu`);
        expect(menuRows()).toEqual([`Rename`, `Change color…`, `Change icon…`, `Show work terminals`, `Move panel into new window`]);
        expect(document.querySelector(`[role="alertdialog"], [role="dialog"]`)).toBeNull();
    });
});
