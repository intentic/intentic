import { describe, expect, it } from "bun:test";
import { effectScope, nextTick, ref } from "vue";
import { useTreeSelection } from "./useTreeSelection";

// Pins the selection's three parts as the gestures move them: one row, a Shift range from the anchor, a Ctrl toggle,
// what lands after a paste, a cleared set that keeps the lead, an opened file collapsing it all, and the one tab stop.

const ORDER = [`src`, `src/api`, `src/main.ts`, `README.md`];

const selectionOver = (opened: string | null | undefined = undefined, order: readonly string[] = ORDER) => {
    const selectedPath = ref(opened);
    const visible = ref(order);
    const selecting = effectScope().run(() => useTreeSelection({ selectedPath: () => selectedPath.value, order: visible }))!;
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
