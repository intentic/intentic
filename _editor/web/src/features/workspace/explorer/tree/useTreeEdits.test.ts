import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import { nextTick } from "vue";
import { dir, file, type StoreOptions, treeSurface } from "../../../../testing/treeSurface";
import { noteArriving } from "../../files/provisionalEntries";

// Pins what the inline field's gestures write, where the selection lands, when a new file opens, and that Enter writes once.

const ZIP: WorkspaceTreeEntry = { ...file(`assets.zip`), children: [file(`assets.zip/guide.md`)] };
// The daemon's answers park until the test lets them through, so the surface can be read while a write is in flight.
const editsOver = (options: StoreOptions = {}) => treeSurface([dir(`src`, [file(`src/main.ts`)]), ZIP], { park: true, ...options });

afterEach(() => {
    resetSandboxScope();
});

describe(`opening the field`, () => {
    it(`opens a rename on the entry's own name, but not on a locked, arriving or archived path`, () => {
        noteArriving(`src/arriving.md`, { kind: `upload` });
        const { inline, edits, store } = editsOver();

        edits.beginRename(`${STATE_DIR}/config/capabilities.json`);
        edits.beginRename(`src/arriving.md`);
        edits.beginRename(`assets.zip/guide.md`);
        expect([inline.edit.value, store.actionError.value?.title]).toEqual([
            { kind: `idle` },
            `An archive's contents are read-only. Extract it to change them.`,
        ]);

        edits.beginRename(`src/main.ts`);
        expect([inline.edit.value, inline.draft.value, inline.editing.value]).toEqual([{ kind: `renaming`, path: `src/main.ts` }, `main.ts`, true]);
    });

    it(`opens a create in its folder, opening that folder first, unless the folder refuses a write`, () => {
        const { inline, edits, store } = editsOver();

        edits.beginCreate(`assets.zip`, `file`);
        expect([inline.edit.value, [...store.expanded.value]]).toEqual([{ kind: `idle` }, []]);

        edits.beginCreate(`src`, `dir`);
        expect([inline.edit.value, inline.draft.value, [...store.expanded.value]]).toEqual([
            { kind: `creating`, dir: `src`, type: `dir` },
            ``,
            [`src`],
        ]);
    });

    it(`checks a new name as it is typed, and says nothing about an empty one`, () => {
        const { inline, edits } = editsOver();
        edits.beginCreate(`src`, `file`);

        expect(inline.createError.value).toBeUndefined();
        inline.draft.value = `main.ts`;
        expect(inline.createError.value).toBe(`"main.ts" already exists.`);
        inline.draft.value = `a/b`;
        expect(inline.createError.value).toBe(`Invalid name.`);
        inline.draft.value = `notes.md`;
        expect(inline.createError.value).toBeUndefined();
    });
});

describe(`ending the field`, () => {
    it(`renames in the entry's folder and selects the new name before the daemon answers`, async () => {
        const { inline, edits, store, selecting, calls, release } = editsOver();
        edits.beginRename(`src/main.ts`);
        inline.draft.value = `entry.ts`;

        await edits.endEdit(`commit`);
        expect([inline.edit.value, store.moveEntry.mock.calls, calls, [...selecting.selection.value]]).toEqual([
            { kind: `idle` },
            [[`src/main.ts`, `src/entry.ts`]],
            [`run: Couldn't rename that.`],
            [`src/entry.ts`],
        ]);
        release();
    });

    it(`says a rename by its new name once it lands, on a surface that asks, and never on one that does not`, async () => {
        const renameOn = async (sayRenamed: boolean) => {
            const surface = treeSurface([dir(`src`, [file(`src/main.ts`)])], { park: true, sayRenamed });
            surface.edits.beginRename(`src/main.ts`);
            surface.inline.draft.value = `entry.ts`;
            await surface.edits.endEdit(`commit`);
            const before = surface.say.mock.calls.length;
            surface.release();
            await surface.store.run.mock.results.at(-1)?.value;
            return [before, surface.say.mock.calls.map(([message]) => message)];
        };

        expect(await renameOn(true)).toEqual([0, [`Renamed to entry.ts`]]);
        expect(await renameOn(false)).toEqual([0, []]);
    });

    it(`creates a file, lands the selection and the keyboard on its entry, and opens it once the daemon has it`, async () => {
        const { inline, edits, selecting, calls, release } = editsOver();
        edits.beginCreate(`src`, `file`);
        inline.draft.value = `notes.md`;

        const ending = edits.endEdit(`commit`);
        await nextTick();
        expect([calls, [...selecting.selection.value]]).toEqual([[`run: Couldn't create that file.`, `focus`], [`src/notes.md`]]);

        release();
        await ending;
        expect(calls.slice(2)).toEqual([`write src/notes.md`, `opened src/notes.md`]);
    });

    it(`opens the package.json a new file folds under in the same frame, so its row never vanishes into the fold`, async () => {
        const { inline, edits, store, selecting, release } = treeSurface([dir(`app`, [file(`app/package.json`), file(`app/README.md`)])], {
            park: true,
            nesting: true,
        });
        edits.beginCreate(`app`, `file`);
        expect([...store.expanded.value]).toEqual([`app`]);
        inline.draft.value = `notes.md`;

        const ending = edits.endEdit(`commit`);
        expect([[...store.expanded.value], [...selecting.selection.value]]).toEqual([[`app`, `app/package.json`], [`app/notes.md`]]);
        release();
        await ending;
    });

    it(`opens a package.json a rename starts, so the files it now folds stay in view`, async () => {
        const { inline, edits, store, release } = treeSurface([dir(`app`, [file(`app/pkg.json`), file(`app/README.md`)])], { nesting: true });
        store.expanded.value = new Set([`app`]);
        edits.beginRename(`app/pkg.json`);
        inline.draft.value = `package.json`;

        await edits.endEdit(`commit`);
        expect([...store.expanded.value]).toEqual([`app`, `app/package.json`]);
        release();
    });

    it(`opens nothing for a file the daemon refused, and nothing for a folder`, async () => {
        const refusedFile = editsOver({ park: false, refused: new Set([`src/notes.md`]) });
        refusedFile.edits.beginCreate(`src`, `file`);
        refusedFile.inline.draft.value = `notes.md`;
        await refusedFile.edits.endEdit(`commit`);

        const folder = editsOver({ park: false });
        folder.edits.beginCreate(`src`, `dir`);
        folder.inline.draft.value = `drafts`;
        await folder.edits.endEdit(`commit`);

        expect([refusedFile.calls, folder.calls]).toEqual([
            [`run: Couldn't create that file.`, `focus`, `write src/notes.md`],
            [`run: Couldn't create that folder.`, `focus`, `mkdir src/drafts`],
        ]);
    });

    it(`writes once for an Enter held down while the first write is in flight`, async () => {
        const { inline, edits, store, release } = editsOver();
        edits.beginCreate(`src`, `file`);
        inline.draft.value = `notes.md`;

        const first = edits.endEdit(`commit`);
        const second = edits.endEdit(`commit`);
        const blur = edits.endEdit(`blur`);
        release();
        await Promise.all([first, second, blur]);

        expect(store.createFile.mock.calls).toEqual([[`src/notes.md`]]);
    });

    it(`drops a refused name on a blur, keeps it open on Enter, and closes on Escape`, async () => {
        const { inline, edits, store } = editsOver();
        edits.beginCreate(`src`, `file`);
        inline.draft.value = `main.ts`;

        await edits.endEdit(`commit`);
        expect(inline.edit.value).toEqual({ kind: `creating`, dir: `src`, type: `file` });
        await edits.endEdit(`blur`);
        expect(inline.edit.value).toEqual({ kind: `idle` });

        edits.beginRename(`src/main.ts`);
        await edits.endEdit(`cancel`);
        expect([inline.edit.value, store.createFile.mock.calls, store.moveEntry.mock.calls]).toEqual([{ kind: `idle` }, [], []]);
    });
});
