import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { MenuItem } from "primevue/menuitem";
import { dir, file, type SurfaceOptions, treeSurface } from "../../../../testing/treeSurface";
import type { RowAction } from "../rowActions";

// Pins the right-click menu: where each verb acts, what a multi-selection counts, and what a guarded target keeps.

const SRC = dir(`app/src`, [file(`app/src/main.ts`)]);
const MAIN = file(`app/src/main.ts`);
const ZIP: WorkspaceTreeEntry = { ...file(`app/assets.zip`), children: [file(`app/assets.zip/logo.png`)] };
const LOGO = file(`app/assets.zip/logo.png`);
const WEB = dir(`app/web`, []);
const SECRET = file(`${STATE_DIR}/config/capabilities.json`);

const menuOver = (options: SurfaceOptions = {}) => {
    const done: string[] = [];
    const docs: RowAction = { id: `docs`, icon: `book`, tooltip: `What src is`, standing: true, run: jest.fn(() => done.push(`docs`)) };
    const surface = treeSurface([SRC, ZIP, WEB], {
        rootDir: `app`,
        barren: [`app/web`],
        rowActions: (at) => (at === `app/src` ? [docs] : []),
        ...options,
    });
    const show = jest.fn((event: Event) => event.type);
    surface.menu.menu.value = { show };
    // Opens the menu on `target` (the background when undefined) and presses each labelled row in turn.
    const press = (target: WorkspaceTreeEntry | undefined, ...labels: string[]): void => {
        surface.menu.openMenu(new MouseEvent(`contextmenu`), target);
        for (const label of labels) {
            const item = surface.menu.menuItems.value.find((row) => row.label === label);
            item?.command?.({ originalEvent: new Event(`click`), item });
        }
    };
    return { ...surface, done, show, press };
};
const labels = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    Object.defineProperty(navigator, `clipboard`, { configurable: true, value: { writeText: () => Promise.resolve() } });
});

describe(`where the verbs act`, () => {
    it(`creates and pastes in a folder itself, beside a file, and in the surface's own root from the background`, async () => {
        const { inline, store, press } = menuOver();
        store.clipboard.value = { mode: `copy`, paths: [`README.md`] };
        const opened = (target: WorkspaceTreeEntry | undefined, label: string) => {
            press(target, label);
            return inline.edit.value;
        };

        expect([opened(SRC, `New File`), opened(MAIN, `New Folder`), opened(undefined, `New File`)]).toEqual([
            { kind: `creating`, dir: `app/src`, type: `file` },
            { kind: `creating`, dir: `app/src`, type: `dir` },
            { kind: `creating`, dir: `app`, type: `file` },
        ]);
        press(SRC, `Paste`);
        press(MAIN, `Paste`);
        press(undefined, `Paste`);
        await drain();
        expect(store.copyEntries.mock.calls.map(([pairs]) => pairs[0]?.to)).toEqual([`app/src/README.md`, `app/src/README.md`, `app/README.md`]);
    });

    it(`renames, extracts and keeps the right-clicked entry, and cuts, copies and deletes through the selection`, async () => {
        const { inline, store, press } = menuOver();

        press(ZIP, `Extract`, `Rename`);
        expect(inline.edit.value).toEqual({ kind: `renaming`, path: `app/assets.zip` });
        press(WEB, `Keep folder`, `Cut`);
        expect(store.clipboard.value).toEqual({ mode: `cut`, paths: [`app/web`] });
        press(WEB, `Copy`, `Delete`);
        await drain();
        expect([store.extractEntry.mock.calls, store.createFile.mock.calls, store.clipboard.value, store.removeEntries.mock.calls]).toEqual([
            [[`app/assets.zip`]],
            [[`app/web/.gitkeep`]],
            { mode: `copy`, paths: [`app/web`] },
            [[[`app/web`]]],
        ]);
    });
});

describe(`what the menu offers`, () => {
    it(`collapses the selection to an entry outside it, keeps a multi-selection it is part of, and counts what the verbs would touch`, () => {
        const { menu, selecting, show, press, select } = menuOver();
        select(`app/src/main.ts`, SECRET.path, `app/web`);

        press(MAIN);
        expect([[...selecting.selection.value], show.mock.calls.length]).toEqual([[`app/src/main.ts`, SECRET.path, `app/web`], 1]);
        expect(labels(menu.menuItems.value)).toEqual([`New File`, `New Folder`, `—`, `Delete 2 items`, `—`, `Cut 2 items`, `Copy 2 items`]);

        press(SRC);
        expect([...selecting.selection.value]).toEqual([`app/src`]);
    });

    it(`lists a folder's own actions as text rows that select it first, between the surface's own first and last rows`, () => {
        const top: MenuItem = { label: `Open` };
        const bottom: MenuItem = { label: `Collapse Folders` };
        const { menu, selecting, done, press } = menuOver({ frame: () => ({ head: [top], tail: [bottom] }) });

        press(SRC, `What src is`);
        expect([labels(menu.menuItems.value).slice(0, 5), labels(menu.menuItems.value).at(-1), done, [...selecting.selection.value]]).toEqual([
            [`Open`, `—`, `New File`, `New Folder`, `What src is`],
            `Collapse Folders`,
            [`docs`],
            [`app/src`],
        ]);
    });

    it(`keeps only reading inside an archive, only the explanation on a private path, and names a read-only member's tier`, () => {
        const writer = menuOver();
        writer.press(LOGO);
        const archived = labels(writer.menu.menuItems.value);
        writer.press(SECRET);
        const locked = labels(writer.menu.menuItems.value);

        const reader = menuOver({ canWrite: false });
        reader.press(SRC);
        expect([archived, locked, labels(reader.menu.menuItems.value)]).toEqual([
            [`Copy`, `—`, `Inside an archive: extract it to change anything`],
            [`Kept private by the sandbox`],
            [`What src is`, `—`, `Read-only: changing files needs writer access`],
        ]);
    });
});
