import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, expect, it, mock } from "bun:test";
import type { MenuItem } from "primevue/menuitem";
import { computed, effectScope, ref, shallowRef } from "vue";
import type { RowAction } from "../rowActions";
import { useTreeMenu } from "./useTreeMenu";

// Pins the right-click menu the tree builds: where each verb acts for a row, a file and the background, what a
// multi-selection counts, what a locked, archived or read-only target keeps, and a folder's own actions as text rows.

const entry = (path: string, type: "file" | "dir"): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type });
const SRC = entry(`app/src`, `dir`);
const MAIN = entry(`app/src/main.ts`, `file`);
const ZIP = entry(`app/assets.zip`, `file`);
const LOGO = entry(`app/assets.zip/logo.png`, `file`);
const WEB = entry(`app/web`, `dir`);
const SECRET = entry(`${STATE_DIR}/config/capabilities.json`, `file`);

const menuOver = (canWrite = true) => {
    const done: string[] = [];
    const docs: RowAction = { id: `docs`, icon: `book`, tooltip: `What src is`, standing: true, run: mock(() => done.push(`docs`)) };
    const selection = ref(new Set<string>());
    const host = {
        rootDir: () => `app`,
        rowActions: (dir: string): readonly RowAction[] => (dir === `app/src` ? [docs] : []),
        isBarren: (path: string) => path === `app/web`,
        rules: {
            archiveDir: (dir: string) => dir.startsWith(`app/assets.zip`),
            unlockedOnly: (paths: readonly string[]) => paths.filter((path) => path !== SECRET.path),
        },
        selecting: {
            selection,
            selectSingle: mock((path: string) => {
                selection.value = new Set([path]);
            }),
        },
        store: {
            canEditFiles: computed(() => canWrite),
            clipboard: shallowRef<{ readonly mode: "copy" | "cut"; readonly paths: readonly string[] } | undefined>(undefined),
            expanded: shallowRef<ReadonlySet<string>>(new Set()),
            collapseAll: mock(() => done.push(`collapse`)),
        },
        beginCreate: mock((dir: string, type: "file" | "dir") => done.push(`create ${type} in ${dir}`)),
        beginRename: mock((path: string) => done.push(`rename ${path}`)),
        extract: mock((path: string) => {
            done.push(`extract ${path}`);
            return Promise.resolve();
        }),
        keepFolder: mock((path: string) => {
            done.push(`keep ${path}`);
            return Promise.resolve();
        }),
        requestDelete: mock(() => done.push(`delete`)),
        stage: mock((mode: "copy" | "cut", system: "async" | "event") => {
            done.push(`${mode} ${system}`);
            return [];
        }),
        paste: mock((dir: string) => {
            done.push(`paste in ${dir}`);
            return Promise.resolve();
        }),
    };
    const menu = effectScope().run(() => useTreeMenu(host))!;
    const show = mock((event: Event) => event.type);
    menu.menu.value = { show };
    // Opens the menu on `target` (the background when undefined) and presses each labelled row in turn.
    const press = (target: WorkspaceTreeEntry | undefined, ...labels: string[]): void => {
        menu.openMenu(new MouseEvent(`contextmenu`), target);
        for (const label of labels) {
            const item = menu.menuItems.value.find((row) => row.label === label);
            item?.command?.({ originalEvent: new Event(`click`), item });
        }
    };
    return { menu, host, done, show, press, docs };
};
const labels = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));

describe(`where the verbs act`, () => {
    it(`creates and pastes in a folder itself, beside a file, and in the tree's own root from the background`, () => {
        const { host, done, press } = menuOver();
        host.store.clipboard.value = { mode: `copy`, paths: [`README.md`] };

        press(SRC, `New File`, `Paste`);
        press(MAIN, `New Folder`, `Paste`);
        press(undefined, `New File`, `Paste`);
        expect(done).toEqual([
            `create file in app/src`,
            `paste in app/src`,
            `create dir in app/src`,
            `paste in app/src`,
            `create file in app`,
            `paste in app`,
        ]);
    });

    it(`renames, extracts and keeps the right-clicked row, and cuts, copies and deletes through the selection`, () => {
        const { done, press } = menuOver();

        press(ZIP, `Extract`, `Rename`);
        press(WEB, `Keep folder`, `Cut`, `Copy`, `Delete`);
        expect(done).toEqual([`extract app/assets.zip`, `rename app/assets.zip`, `keep app/web`, `cut async`, `copy async`, `delete`]);
    });
});

describe(`what the menu offers`, () => {
    it(`collapses the selection to a row outside it, keeps a multi-selection it is part of, and counts what the verbs would touch`, () => {
        const { menu, host, show, press } = menuOver();
        host.selecting.selection.value = new Set([`app/src/main.ts`, SECRET.path, `app/web`]);

        press(MAIN);
        expect([[...host.selecting.selection.value], show.mock.calls.length]).toEqual([[`app/src/main.ts`, SECRET.path, `app/web`], 1]);
        expect(labels(menu.menuItems.value)).toEqual([`New File`, `New Folder`, `—`, `Delete 2 items`, `—`, `Cut 2 items`, `Copy 2 items`]);

        press(SRC);
        expect([...host.selecting.selection.value]).toEqual([`app/src`]);
    });

    it(`lists a folder's own actions as text rows that select it first, and offers to collapse only while something is open`, () => {
        const { menu, host, done, press } = menuOver();
        host.store.expanded.value = new Set([`app/src`]);

        press(SRC, `What src is`, `Collapse Folders`);
        expect([labels(menu.menuItems.value).slice(0, 3), labels(menu.menuItems.value).at(-1), done, [...host.selecting.selection.value]]).toEqual([
            [`New File`, `New Folder`, `What src is`],
            `Collapse Folders`,
            [`docs`, `collapse`],
            [`app/src`],
        ]);

        host.store.expanded.value = new Set();
        expect(labels(menu.menuItems.value).at(-1)).toBe(`Copy`);
    });

    it(`keeps only reading inside an archive, only the explanation on a private path, and names a read-only member's tier`, () => {
        const writer = menuOver();
        writer.press(LOGO);
        const archived = labels(writer.menu.menuItems.value);
        writer.press(SECRET);
        const locked = labels(writer.menu.menuItems.value);

        const reader = menuOver(false);
        reader.press(SRC);
        expect([archived, locked, labels(reader.menu.menuItems.value)]).toEqual([
            [`Copy`, `—`, `Inside an archive: extract it to change anything`],
            [`Kept private by the sandbox`],
            [`What src is`, `—`, `Read-only: changing files needs writer access`],
        ]);
    });
});
