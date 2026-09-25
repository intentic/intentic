import { effectScope, nextTick, ref, watch } from "vue";
import { useMultiSelect } from "./multiSelect";

// Pins the selection's three parts as the gestures move them: one row, a Shift range from the anchor, a Ctrl toggle,
// what lands after a paste, a cleared set that keeps the lead, an opened file collapsing it all, and the one tab stop.
// One model for every multi-selecting surface: the tree, whose lead is its own cursor, and the home, whose lead is the
// page's shared current entry.

const ORDER = [`src`, `src/api`, `src/main.ts`, `README.md`];

const selectionOver = (opened: string | null | undefined = undefined, order: readonly string[] = ORDER) => {
    const selectedPath = ref(opened);
    const visible = ref(order);
    // The tree's own wiring: the selection follows the file the editor opens.
    const selecting = effectScope().run(() => {
        const made = useMultiSelect(visible);
        made.follow(selectedPath.value ?? null);
        watch(selectedPath, (path) => made.follow(path ?? null));
        return made;
    })!;
    const state = () => ({ selected: [...selecting.selection.value], anchor: selecting.anchor.value, lead: selecting.lead.value });
    return { selecting, selectedPath, visible, state };
};

describe(`the selection`, () => {
    it(`starts on the open file, or on nothing`, () => {
        expect(selectionOver(`src/main.ts`).state()).toEqual({ selected: [`src/main.ts`], anchor: `src/main.ts`, lead: `src/main.ts` });
        expect(selectionOver(null).state()).toEqual({ selected: [], anchor: null, lead: null });
    });

    it(`ranges from the anchor in visible order, and from the row itself with no anchor`, () => {
        const { selecting, state } = selectionOver();
        selecting.selectSingle(`README.md`);
        selecting.extendTo(`src/api`);
        expect(state()).toEqual({ selected: [`src/api`, `src/main.ts`, `README.md`], anchor: `README.md`, lead: `src/api` });

        const fresh = selectionOver();
        fresh.selecting.extendTo(`src/api`);
        expect(fresh.state()).toEqual({ selected: [`src/api`], anchor: null, lead: `src/api` });
    });

    it(`toggles a row in and out, moving the anchor and the lead to it`, () => {
        const { selecting, state } = selectionOver(`src`);
        selecting.toggleAt(`README.md`);
        expect(state()).toEqual({ selected: [`src`, `README.md`], anchor: `README.md`, lead: `README.md` });

        selecting.toggleAt(`src`);
        expect(state()).toEqual({ selected: [`README.md`], anchor: `src`, lead: `src` });
    });

    it(`selects what landed with the last of it leading, and clears without losing the lead`, () => {
        const { selecting, state } = selectionOver(`src`);
        selecting.selectLanded([`src/a.ts`, `src/b.ts`]);
        expect(state()).toEqual({ selected: [`src/a.ts`, `src/b.ts`], anchor: `src/b.ts`, lead: `src/b.ts` });

        selecting.clear();
        expect(state()).toEqual({ selected: [], anchor: null, lead: `src/b.ts` });
        selecting.selectLanded([]);
        expect(state()).toEqual({ selected: [], anchor: null, lead: null });
    });

    it(`collapses to a file the editor opens, whatever was selected, and to nothing when it closes`, async () => {
        const { selecting, selectedPath, state } = selectionOver(`src`);
        selecting.toggleAt(`README.md`);

        selectedPath.value = `src/api`;
        await nextTick();
        expect(state()).toEqual({ selected: [`src/api`], anchor: `src/api`, lead: `src/api` });

        selectedPath.value = null;
        await nextTick();
        expect(state()).toEqual({ selected: [], anchor: null, lead: null });
    });
});

describe(`the tab stop`, () => {
    it(`is the lead while it is a row, else the first row, else nothing at all`, () => {
        const { selecting, visible } = selectionOver(`src/main.ts`);
        expect(selecting.tabbablePath.value).toBe(`src/main.ts`);

        visible.value = [`README.md`];
        expect(selecting.tabbablePath.value).toBe(`README.md`);

        visible.value = [];
        expect(selecting.tabbablePath.value).toBeNull();
    });
});

describe(`a shared lead`, () => {
    const sharedOver = (current: string | null = null) => {
        const lead = ref<string | null>(current);
        const visible = ref<readonly string[]>(ORDER);
        const selecting = effectScope().run(() => useMultiSelect(visible, { lead }))!;
        const state = () => ({ selected: [...selecting.selection.value], anchor: selecting.anchor.value, lead: lead.value });
        return { selecting, lead, visible, state };
    };

    it(`starts on the current entry when it is listed, and selects with modifiers as a press would`, () => {
        const { selecting, state } = sharedOver(`src/api`);
        expect(state()).toEqual({ selected: [`src/api`], anchor: `src/api`, lead: `src/api` });

        selecting.select(`README.md`, { shiftKey: true, ctrlKey: false, metaKey: false });
        expect(state()).toEqual({ selected: [`src/api`, `src/main.ts`, `README.md`], anchor: `src/api`, lead: `README.md` });
        selecting.select(`src`, { shiftKey: false, ctrlKey: true, metaKey: false });
        expect(state()).toEqual({ selected: [`src/api`, `src/main.ts`, `README.md`, `src`], anchor: `src`, lead: `src` });
        selecting.select(`src/main.ts`);
        expect(state()).toEqual({ selected: [`src/main.ts`], anchor: `src/main.ts`, lead: `src/main.ts` });
    });

    it(`follows the lead set elsewhere, empties for one that is not listed, and drops entries that left`, async () => {
        const { selecting, lead, visible, state } = sharedOver();
        lead.value = `README.md`;
        await nextTick();
        expect(state()).toEqual({ selected: [`README.md`], anchor: `README.md`, lead: `README.md` });

        lead.value = `elsewhere`;
        await nextTick();
        expect(state()).toEqual({ selected: [], anchor: null, lead: `elsewhere` });

        selecting.selectAll();
        visible.value = [`src`, `README.md`];
        await nextTick();
        expect(state().selected).toEqual([`src`, `README.md`]);
    });

    it(`clears the lead with the selection, since it named something no longer marked`, () => {
        const { selecting, state } = sharedOver(`src`);
        selecting.clear();
        expect(state()).toEqual({ selected: [], anchor: null, lead: null });
    });
});
