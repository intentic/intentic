import "@intentic/testing/dom";
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { MenuItem } from "primevue/menuitem";
import { computed, type EffectScope, effectScope, ref } from "vue";
import { setTerminalMeta, terminalMeta } from "../terminalMeta";
import type { TerminalTab } from "../useTerminal";
import { useTerminalStrip } from "./useTerminalStrip";

// Pins the strip's gestures headlessly: a plain press switches while Shift and Ctrl only select, every kill route asks
// the same question and a read-only strip offers none, rename commits once and an empty name resets, and each context
// menu offers exactly the rows that would do something, the strip-wide rows last.

const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;
const shell = (name: string, over: Partial<TerminalTab> = {}): TerminalTab => ({
    name,
    kind: `shell`,
    running: true,
    activityAt: minutesAgo(0),
    ...over,
});
const scopes: EffectScope[] = [];
const labels = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));
const run = (items: readonly MenuItem[], label: string): void => {
    items.find((item) => item.label === label)?.command?.({ originalEvent: new Event(`click`), item: {} });
};
const pressed = (over: Partial<MouseEventInit> = {}): MouseEvent => new MouseEvent(`click`, over);

const stage = (over: { readOnly?: boolean; groups?: string[][]; order?: TerminalTab[] } = {}) => {
    const order = ref<TerminalTab[]>(over.order ?? [shell(`a`), shell(`b`), shell(`c`), shell(`d`)]);
    const layout = ref<string[][]>(over.groups ?? [[`a`], [`b`, `c`], [`d`]]);
    const activeName = ref<string | undefined>(`a`);
    const verbs = {
        switchTab: mock((_name: string) => undefined),
        joinTabs: mock((_names: string[]) => undefined),
        unsplit: mock((_name: string) => undefined),
    };
    const splitTab = mock((_name: string) => undefined);
    const killTabs = mock((_names: string[]) => undefined);
    const floating = { floats: ref(false), toggle: mock() };
    const scope = effectScope();
    scopes.push(scope);
    const tabs = {
        order,
        groups: computed(() => layout.value),
        activeName,
        ...verbs,
        splitTab: over.readOnly === true ? undefined : splitTab,
        killTabs: over.readOnly === true ? undefined : killTabs,
    };
    const strip = scope.run(() => useTerminalStrip({ tabs, floating }))!;
    const show = mock((_event: Event) => undefined);
    strip.menu.value = { show };
    return { order, activeName, verbs, splitTab, killTabs, floating, strip, show };
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    for (const name of [`a`, `b`, `c`, `d`]) {
        setTerminalMeta(name, { label: undefined, color: undefined, icon: undefined });
    }
});

describe(`pressing a pill`, () => {
    it(`switches on a plain press, and only selects under Shift or Ctrl`, () => {
        const { verbs, strip } = stage();
        strip.onSegmentClick(pressed({ shiftKey: true }), 2, `d`);
        expect(strip.selectedNames.value).toEqual([`a`, `b`, `c`, `d`]);
        strip.onSegmentClick(pressed({ ctrlKey: true }), 1, `b`);
        expect(strip.selectedNames.value).toEqual([`a`, `d`]);
        expect(verbs.switchTab).not.toHaveBeenCalled();
        strip.onSegmentClick(pressed(), 2, `d`);
        expect({ selected: strip.selectedNames.value, switched: verbs.switchTab.mock.calls }).toEqual({ selected: [], switched: [[`d`]] });
    });

    it(`numbers unlabelled shells in reading order across splits`, () => {
        const { strip } = stage();
        expect([`a`, `b`, `c`, `d`].map(strip.segmentLabel)).toEqual([`1`, `2`, `3`, `4`]);
        expect(strip.defaultLabel(`c`)).toBe(`Terminal 3`);
    });

    it(`walks every session in reading order, wrapping at both ends`, () => {
        const { activeName, verbs, strip } = stage();
        strip.cycleTab(-1);
        activeName.value = `d`;
        strip.cycleTab(1);
        expect(verbs.switchTab.mock.calls).toEqual([[`d`], [`a`]]);
    });
});

describe(`killing`, () => {
    it(`kills an idle session on the press, with nothing left selected`, () => {
        const { killTabs, strip } = stage();
        strip.onSegmentClick(pressed({ ctrlKey: true }), 0, `a`);
        strip.requestKill([`a`]);
        expect({ killed: killTabs.mock.calls, pending: strip.pendingKill.value, selected: strip.selectedNames.value }).toEqual({
            killed: [[[`a`]]],
            pending: undefined,
            selected: [],
        });
    });

    it(`asks before killing a busy session, and kills only once confirmed`, () => {
        const { killTabs, strip } = stage({ order: [shell(`a`, { command: `pnpm build` }), shell(`b`)] });
        strip.middleKill(`a`);
        expect(killTabs).not.toHaveBeenCalled();
        expect(strip.killPrompt.value.header).toBe(`Kill the terminal running pnpm build?`);
        strip.confirmKill();
        expect({ killed: killTabs.mock.calls, pending: strip.pendingKill.value }).toEqual({ killed: [[[`a`]]], pending: undefined });
    });

    it(`never kills a pill being renamed on a middle-click`, () => {
        const { killTabs, strip } = stage();
        strip.beginRename(`a`);
        strip.middleKill(`a`);
        expect(killTabs).not.toHaveBeenCalled();
    });

    it(`sweeps the quiet and the finished, sparing the focused session and a running command`, () => {
        const { killTabs, strip } = stage({
            order: [
                shell(`a`, { activityAt: minutesAgo(30) }),
                shell(`b`, { activityAt: minutesAgo(30) }),
                shell(`c`, { running: false }),
                shell(`d`, { command: `top` }),
            ],
        });
        strip.sweepInactive();
        expect(killTabs.mock.calls).toEqual([[[`b`, `c`]]]);
    });

    it(`offers and does no kill on a read-only strip`, () => {
        const { strip, show } = stage({ readOnly: true });
        strip.requestKill([`a`]);
        strip.sweepInactive();
        strip.openTabMenu(pressed(), 0, `a`);
        expect(show).toHaveBeenCalledTimes(1);
        expect(labels(strip.menuItems.value)).toEqual([
            `Rename`,
            `Change color…`,
            `Change icon…`,
            `Show work terminals`,
            `Move panel into new window`,
        ]);
    });
});

describe(`renaming and restyling`, () => {
    it(`commits once, trimmed, and resets on an empty name`, () => {
        const { strip } = stage();
        strip.beginRename(`a`);
        strip.renameDraft.value = `  api  `;
        strip.commitRename();
        strip.commitRename();
        expect(terminalMeta(`a`).label).toBe(`api`);
        strip.beginRename(`a`);
        expect(strip.renameDraft.value).toBe(`api`);
        strip.renameDraft.value = ``;
        strip.commitRename();
        expect(terminalMeta(`a`).label).toBe(undefined);
    });

    it(`leaves the name alone when the edit is cancelled`, () => {
        const { strip } = stage();
        strip.beginRename(`a`);
        strip.renameDraft.value = `api`;
        strip.cancelRename();
        strip.commitRename();
        expect(terminalMeta(`a`).label).toBe(undefined);
    });

    it(`applies a picked colour or icon and closes the picker`, () => {
        const { strip } = stage();
        strip.openCustomize(`a`, `color`);
        expect(strip.customizeHeader.value).toBe(`Terminal color`);
        strip.applyColor(`cyan`);
        strip.openCustomize(`a`, `icon`);
        strip.applyIcon(`star`);
        expect({ meta: terminalMeta(`a`), open: strip.customize.value }).toEqual({ meta: { color: `cyan`, icon: `star` }, open: undefined });
    });
});

describe(`the context menus`, () => {
    it(`offers a single pill split, unsplit where it is in a group, restyling, and its kill, then the strip's rows`, () => {
        const { strip } = stage();
        strip.openTabMenu(pressed(), 1, `b`);
        expect(labels(strip.menuItems.value)).toEqual([
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

    it(`offers mass actions for a selection spanning groups, and joins it`, () => {
        const { verbs, strip } = stage();
        strip.onSegmentClick(pressed({ shiftKey: true }), 1, `b`);
        strip.openTabMenu(pressed(), 1, `b`);
        expect(labels(strip.menuItems.value).slice(0, 3)).toEqual([`Join 2 tabs`, `—`, `Kill 3 terminals`]);
        run(strip.menuItems.value, `Join 2 tabs`);
        expect({ joined: verbs.joinTabs.mock.calls, selected: strip.selectedNames.value }).toEqual({ joined: [[[`a`, `b`, `c`]]], selected: [] });
    });

    it(`opens the strip-wide rows alone on empty bar space, and not over a pill or a button`, () => {
        const { strip, show } = stage({ order: [shell(`a`), shell(`b`, { activityAt: minutesAgo(30) })], groups: [[`a`], [`b`]] });
        const pill = document.createElement(`div`);
        pill.dataset[`termTab`] = ``;
        document.body.append(pill);
        const onPill = new MouseEvent(`contextmenu`, { cancelable: true });
        pill.dispatchEvent(onPill);
        strip.onBarContextMenu(onPill);
        const bar = new MouseEvent(`contextmenu`, { cancelable: true });
        document.body.dispatchEvent(bar);
        strip.onBarContextMenu(bar);
        expect(show).toHaveBeenCalledTimes(1);
        expect(labels(strip.menuItems.value)).toEqual([
            `Kill 1 inactive terminal`,
            `Kill all terminals`,
            `—`,
            `Show work terminals`,
            `Move panel into new window`,
        ]);
        pill.remove();
    });

    it(`joins from the chord only a selection spanning more than one group`, () => {
        const { verbs, strip } = stage();
        strip.joinSelected();
        strip.onSegmentClick(pressed({ ctrlKey: true }), 0, `a`);
        strip.onSegmentClick(pressed({ ctrlKey: true }), 2, `d`);
        strip.joinSelected();
        expect(verbs.joinTabs.mock.calls).toEqual([[[`a`, `d`]]]);
    });
});
