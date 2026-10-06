import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { SANDBOX_ROUTE_NAMES, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import type { MenuItem } from "primevue/menuitem";
import { unstubbed } from "@intentic/testing";
import { ref } from "vue";
import { useMultiSelect } from "../../../../lib/multiSelect";
import { setDaemonRoutes } from "../../../../client/sandbox/useDaemonRoutes";
import { dir, fakeTreeStore, file, type SurfaceOptions, treeSurface } from "../../../../testing/treeSurface";
import type { RowAction } from "../rowActions";
import { type TreeMenuHost, useTreeMenu } from "./useTreeMenu";

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

describe(`downloading`, () => {
    it(`hands one file over as itself, and a folder or a selection as one ZIP, the private entries left out`, async () => {
        const { download, say, press, select } = menuOver();
        press(MAIN, `Download`);
        press(SRC, `Download as ZIP`);
        select(`app/src/main.ts`, SECRET.path, `app/web`);
        press(MAIN, `Download 2 items as ZIP`);
        await drain();
        expect(download.mock.calls.map(([targets]) => targets)).toEqual([
            [{ path: `app/src/main.ts`, type: `file` }],
            [{ path: `app/src`, type: `dir` }],
            [
                { path: `app/src/main.ts`, type: `file` },
                { path: `app/web`, type: `dir` },
            ],
        ]);
        // Only an archive is announced: a single file shows up in the browser's downloads at once.
        expect(say.mock.calls.map(([message]) => message)).toEqual([`Downloading selection.zip`, `Downloading selection.zip`]);
    });

    it(`lets a read-only member download too, since it changes nothing`, async () => {
        const { download, press } = menuOver({ canWrite: false });
        press(SRC, `Download as ZIP`);
        await drain();
        expect(download).toHaveBeenCalledTimes(1);
    });
});

describe(`what the menu offers`, () => {
    it(`collapses the selection to an entry outside it, keeps a multi-selection it is part of, and counts what the verbs would touch`, () => {
        const { menu, selecting, show, press, select } = menuOver();
        select(`app/src/main.ts`, SECRET.path, `app/web`);

        press(MAIN);
        expect([[...selecting.selection.value], show.mock.calls.length]).toEqual([[`app/src/main.ts`, SECRET.path, `app/web`], 1]);
        expect(labels(menu.menuItems.value)).toEqual([
            `New File`,
            `New Folder`,
            `—`,
            `Delete 2 items`,
            `—`,
            `Cut 2 items`,
            `Copy 2 items`,
            `Download 2 items as ZIP`,
        ]);

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
            [`Copy`, `Download`, `—`, `Inside an archive: extract it to change anything`],
            [`Kept private by the sandbox`],
            [`What src is`, `—`, `Download as ZIP`, `—`, `Read-only: changing files needs writer access`],
        ]);
    });
});

// The menu reads what the backend said it serves (its /events hello): a folder on this computer, through the desktop
// app's sidecar, serves the tree's reads and the upload route, and none of the verbs that move, copy, delete or unpack.
describe(`what the backend serves`, () => {
    const FOLDER = [`workspace.tree`, `workspace.children`, `workspace.file`, `system.events`, `GET /workspace/raw`, `POST /workspace/upload`];
    afterEach(() => resetSandboxScope());

    it(`hides the verbs a folder on this computer does not serve, and the same verbs reached by key do nothing`, () => {
        setDaemonRoutes(FOLDER, undefined, `folder`);
        const { menu, inline, edits, deleting, transfer, store, press, select } = menuOver();
        press(ZIP);
        const onArchive = labels(menu.menuItems.value);
        press(SRC);
        const onFolder = labels(menu.menuItems.value);
        select(`app/src/main.ts`, `app/web`);
        press(MAIN);
        const onSelection = labels(menu.menuItems.value);
        expect([onArchive, onFolder, onSelection]).toEqual([
            [`New File`, `—`, `Download`],
            [`New File`, `What src is`],
            [`New File`],
        ]);
        // The same verbs reached without the menu (F2, Delete, Ctrl+X and Ctrl+C on the selection) open, stage and send nothing.
        edits.beginRename(`app/src/main.ts`);
        edits.beginCreate(`app/src`, `dir`);
        deleting.requestDelete();
        expect([inline.edit.value.kind, transfer.stage(`cut`, `event`), transfer.stage(`copy`, `event`), store.removeEntries.mock.calls]).toEqual([
            `idle`,
            [],
            [],
            [],
        ]);
    });

    it(`still offers every verb to a daemon that serves them`, () => {
        setDaemonRoutes([...SANDBOX_ROUTE_NAMES], undefined, `sandbox`);
        const { menu, press } = menuOver();
        press(ZIP);
        const onArchive = labels(menu.menuItems.value);
        press(SRC);
        expect([onArchive, labels(menu.menuItems.value)]).toEqual([
            [`New File`, `New Folder`, `—`, `Extract`, `Rename`, `Delete`, `—`, `Cut`, `Copy`, `Download`],
            [`New File`, `New Folder`, `What src is`, `Open Terminal`, `—`, `Rename`, `Delete`, `—`, `Cut`, `Copy`, `Download as ZIP`],
        ]);
    });
});

// A folder on this computer (the desktop app's local window): its seams hand the menu no terminal, no unpacking and no
// download (fileVerbSeams.ts), and its tree hands it the one way to an agent there is (local/LocalFiles.vue). Built on
// the menu's own host, since the shared surface always has a sandbox's seams.
describe(`a surface without a sandbox's seams`, () => {
    const localMenu = () => {
        const asked: string[] = [];
        const { store } = fakeTreeStore([SRC, ZIP, WEB]);
        const menu = useTreeMenu(
            unstubbed<TreeMenuHost>(`treeMenuHost`, {
                rootDir: () => `app`,
                rowActions: () => [],
                isBarren: (path) => path === WEB.path,
                rules: { archiveDir: () => false, unlockedOnly: (paths) => [...paths] },
                selecting: useMultiSelect(ref([SRC.path, MAIN.path, ZIP.path, WEB.path])),
                store,
                frame: () => ({}),
                extract: undefined,
                openTerminal: undefined,
                download: undefined,
                ask: (path) => asked.push(path),
            }),
        );
        menu.menu.value = { show: jest.fn() };
        const press = (target: WorkspaceTreeEntry, ...rows: string[]): void => {
            menu.openMenu(new MouseEvent(`contextmenu`), target);
            for (const label of rows) {
                const item = menu.menuItems.value.find((row) => row.label === label);
                item?.command?.({ originalEvent: new Event(`click`), item });
            }
        };
        return { menu, asked, press };
    };

    it(`offers no terminal, Extract or Download, and asks an agent about the file right-clicked`, () => {
        const { menu, asked, press } = localMenu();
        press(ZIP, `Ask an agent about this`);
        const onArchive = labels(menu.menuItems.value);
        press(WEB);
        const onFolder = labels(menu.menuItems.value);
        expect([onArchive, onFolder, asked]).toEqual([
            [`Ask an agent about this`, `—`, `New File`, `New Folder`, `—`, `Rename`, `Delete`, `—`, `Cut`, `Copy`],
            [`New File`, `New Folder`, `—`, `Rename`, `Keep folder`, `Delete`, `—`, `Cut`, `Copy`],
            [ZIP.path],
        ]);
    });
});
