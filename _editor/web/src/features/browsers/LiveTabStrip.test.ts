// What the strip draws of a web page's tab and what its gestures say back: the site's icon, the speaker, the tab's own
// menu, a drag along a window's run. What each tab is and what a verb does are the caller's (stripTab.ts, tabVerbs.ts).
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import type { MenuItem } from "primevue/menuitem";
import { type App, createApp, h, nextTick } from "vue";
import LiveTabStrip from "./LiveTabStrip.vue";
import type { StripGroup, StripTab } from "./stripTab";

const FAVICON = `data:image/png;base64,iVBORw0KGgo=`;
const own: StripGroup = { id: `own`, label: `Your browser`, mark: { kind: `icon`, icon: `user` }, current: true };
const tab = (id: string, extra: Partial<StripTab> = {}): StripTab => ({
    id,
    label: `title ${id}`,
    icon: `globe`,
    closable: true,
    movable: true,
    pinned: false,
    group: own,
    ...extra,
});

// What the strip said back, gesture by gesture.
interface Heard {
    readonly mute: string[];
    readonly move: [string, number][];
    readonly pick: string[];
}

const mounted: App[] = [];
afterEach(async () => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
    document.body.replaceChildren();
    // PrimeVue's overlays schedule their own removal on a zero-delay timer; run it while a document exists.
    await new Promise((resolve) => setTimeout(resolve));
});

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

const stage = async (tabs: readonly StripTab[], menuOf?: (tab: StripTab) => MenuItem[]) => {
    const heard: Heard = { mute: [], move: [], pick: [] };
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({
        render: () =>
            h(LiveTabStrip, {
                tabs,
                activeId: tabs[0]?.id,
                menuOf,
                onMute: (muted: StripTab) => heard.mute.push(muted.id),
                onMove: (moved: StripTab, to: number) => heard.move.push([moved.id, to]),
                onPick: (picked: StripTab) => heard.pick.push(picked.id),
            }),
    });
    app.use(PrimeVue);
    app.directive(`tooltip`, {});
    app.mount(host);
    mounted.push(app);
    await settle();
    return { host, heard };
};

const tabOf = (host: HTMLElement, id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;

// Lays the run's tabs out side by side, each `width` wide: the test document has no layout of its own.
const layOut = (host: HTMLElement, ids: readonly string[], width: number): void => {
    for (const [index, id] of ids.entries()) {
        const el = tabOf(host, id);
        Object.defineProperty(el, `offsetLeft`, { configurable: true, value: index * width });
        Object.defineProperty(el, `offsetWidth`, { configurable: true, value: width });
    }
};

const pointer = (type: string, clientX: number): Event =>
    Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }), { pointerType: `mouse`, pointerId: 1 });

describe(`a web page's tab on the strip`, () => {
    test(`shows its site's icon where it has one, and its glyph where it has none`, async () => {
        const { host } = await stage([tab(`p1`, { favicon: FAVICON }), tab(`p2`)]);
        const icons = [...host.querySelectorAll<HTMLImageElement>(`[data-tab-id] img`)];
        expect(icons.map((icon) => [icon.closest(`[data-tab-id]`)?.getAttribute(`data-tab-id`), icon.getAttribute(`src`), icon.alt])).toEqual([
            [`p1`, FAVICON, ``],
        ]);
    });

    test(`has a speaker while it plays sound or is muted, which says which and mutes on a press`, async () => {
        const { host, heard } = await stage([tab(`p1`, { sound: `playing` }), tab(`p2`, { sound: `muted` }), tab(`p3`)]);
        const speakers = [...host.querySelectorAll<HTMLButtonElement>(`[data-tab-id] button[aria-pressed]`)];
        expect(speakers.map((speaker) => [speaker.closest(`[data-tab-id]`)?.getAttribute(`data-tab-id`), speaker.getAttribute(`aria-pressed`)])).toEqual([
            [`p1`, `false`],
            [`p2`, `true`],
        ]);
        speakers[1]?.click();
        await settle();
        expect(heard.mute).toEqual([`p2`]);
        // The press is the speaker's, not a pick of the tab.
        expect(heard.pick).toEqual([]);
    });

    test(`opens the rows its caller gives on a right-click, and nothing where the caller gives none`, async () => {
        const reloaded: string[] = [];
        const menuOf = (pressed: StripTab): MenuItem[] =>
            pressed.id === `p1` ? [{ label: `Reload`, command: () => reloaded.push(pressed.id) }, { separator: true }, { label: `Close tab` }] : [];
        const { host } = await stage([tab(`p1`), tab(`p2`)], menuOf);
        tabOf(host, `p2`).dispatchEvent(new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true, clientX: 20, clientY: 10 }));
        await settle();
        expect(document.querySelectorAll(`[role="menuitem"]`)).toHaveLength(0);
        const right = new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
        tabOf(host, `p1`).dispatchEvent(right);
        await settle();
        expect(right.defaultPrevented).toBe(true);
        expect([...document.querySelectorAll(`[role="menuitem"]`)].map((row) => row.getAttribute(`aria-label`))).toEqual([`Reload`, `Close tab`]);
        document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="Reload"] a`)?.click();
        await settle();
        expect(reloaded).toEqual([`p1`]);
    });
});

describe(`dragging a tab along its window's run`, () => {
    test(`lets it go at the place it was carried to, and the release picks nothing`, async () => {
        const { host, heard } = await stage([tab(`p1`), tab(`p2`), tab(`p3`)]);
        layOut(host, [`p1`, `p2`, `p3`], 100);
        const carried = tabOf(host, `p1`);
        carried.dispatchEvent(pointer(`pointerdown`, 50));
        window.dispatchEvent(pointer(`pointermove`, 120));
        window.dispatchEvent(pointer(`pointermove`, 255));
        await settle();
        // While carried it follows the pointer, and the tabs it passed step aside toward the place it left.
        expect(carried.style.transform).toBe(`translateX(205px)`);
        expect(tabOf(host, `p2`).style.transform).toBe(`translateX(-100px)`);
        expect(tabOf(host, `p3`).style.transform).toBe(`translateX(-100px)`);
        window.dispatchEvent(pointer(`pointerup`, 255));
        carried.querySelector<HTMLButtonElement>(`button[role="tab"]`)?.click();
        await settle();
        expect(heard.move).toEqual([[`p1`, 2]]);
        expect(heard.pick).toEqual([]);
        expect(carried.style.transform).toBe(``);
    });

    test(`a press that never travels is a pick, and Escape puts a carried tab back`, async () => {
        const { host, heard } = await stage([tab(`p1`), tab(`p2`)]);
        layOut(host, [`p1`, `p2`], 100);
        tabOf(host, `p2`).dispatchEvent(pointer(`pointerdown`, 150));
        window.dispatchEvent(pointer(`pointermove`, 152));
        window.dispatchEvent(pointer(`pointerup`, 152));
        tabOf(host, `p2`).querySelector<HTMLButtonElement>(`button[role="tab"]`)?.click();
        await settle();
        expect(heard.pick).toEqual([`p2`]);

        tabOf(host, `p2`).dispatchEvent(pointer(`pointerdown`, 150));
        window.dispatchEvent(pointer(`pointermove`, 20));
        window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
        window.dispatchEvent(pointer(`pointerup`, 20));
        await settle();
        expect(heard.move).toEqual([]);
        expect(tabOf(host, `p2`).style.transform).toBe(``);
    });

    test(`a pin, or a tab of a window the person cannot drive, stays where it is`, async () => {
        const { host, heard } = await stage([tab(`app`, { pinned: true, movable: false, group: undefined }), tab(`p1`, { movable: false }), tab(`p2`, { movable: false })]);
        layOut(host, [`p1`, `p2`], 100);
        tabOf(host, `p1`).dispatchEvent(pointer(`pointerdown`, 50));
        window.dispatchEvent(pointer(`pointermove`, 180));
        window.dispatchEvent(pointer(`pointerup`, 180));
        await settle();
        expect(heard.move).toEqual([]);
        expect(tabOf(host, `p1`).style.transform).toBe(``);
    });
});
