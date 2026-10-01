import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { MenuItem } from "primevue/menuitem";
import { SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { type EntryMenuInput, type EntryVerbs, entryMenuItems, VERB_ROUTES, ZIP_ROUTE } from "../entryMenu";

const file: WorkspaceTreeEntry = { name: `a.ts`, path: `src/a.ts`, type: `file` };
const dir: WorkspaceTreeEntry = { name: `src`, path: `src`, type: `dir`, children: [] };

const verbs = (): EntryVerbs => ({
    newFile: jest.fn(),
    newFolder: jest.fn(),
    rename: jest.fn(),
    extract: jest.fn(),
    keepFolder: jest.fn(),
    remove: jest.fn(),
    cut: jest.fn(),
    copy: jest.fn(),
    paste: jest.fn(),
    openTerminal: jest.fn(),
    download: jest.fn(),
});
const input = (over: Partial<EntryMenuInput> = {}): EntryMenuInput => ({
    target: file,
    locked: false,
    canEdit: true,
    archived: false,
    multi: false,
    count: 1,
    barren: false,
    clipboardFull: false,
    verbs: verbs(),
    ...over,
});
// The menu as a reader scans it: labels, with a separator drawn as a rule.
const labels = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));

describe(`the entry menu`, () => {
    it(`offers a file its verbs, with the creates first`, () => {
        expect(labels(entryMenuItems(input()))).toEqual([`New File`, `New Folder`, `—`, `Rename`, `Delete`, `—`, `Cut`, `Copy`, `Download`]);
    });

    it(`counts a bulk verb and drops Rename, which only ever names one`, () => {
        expect(labels(entryMenuItems(input({ multi: true, count: 3 })))).toEqual([
            `New File`,
            `New Folder`,
            `—`,
            `Delete 3 items`,
            `—`,
            `Cut 3 items`,
            `Copy 3 items`,
            `Download 3 items as ZIP`,
        ]);
    });

    it(`offers only the creates on the background, and Paste once something is staged`, () => {
        expect(labels(entryMenuItems(input({ target: undefined })))).toEqual([`New File`, `New Folder`]);
        expect(labels(entryMenuItems(input({ target: undefined, clipboardFull: true })))).toEqual([`New File`, `New Folder`, `Paste`]);
    });

    it(`offers Open Terminal on one folder, never on a file, a bulk selection or to a read-only member`, () => {
        const opened = input({ target: dir });
        const row = entryMenuItems(opened).find((item) => item.label === `Open Terminal`);
        row?.command?.({} as never);
        expect(opened.verbs.openTerminal).toHaveBeenCalledTimes(1);
        expect(labels(entryMenuItems(input({ target: file })))).not.toContain(`Open Terminal`);
        expect(labels(entryMenuItems(input({ target: dir, multi: true, count: 2 })))).not.toContain(`Open Terminal`);
        expect(labels(entryMenuItems(input({ target: dir, canEdit: false })))).not.toContain(`Open Terminal`);
    });

    it(`offers Keep folder to one empty folder chain, never to a file or a bulk selection`, () => {
        expect(labels(entryMenuItems(input({ target: dir, barren: true })))).toContain(`Keep folder`);
        expect(labels(entryMenuItems(input({ target: dir, barren: true, multi: true, count: 2 })))).not.toContain(`Keep folder`);
        expect(labels(entryMenuItems(input({ target: file, barren: true })))).not.toContain(`Keep folder`);
    });

    it(`offers Extract to one archive, and to nothing the sandbox can't unpack`, () => {
        const zip: WorkspaceTreeEntry = { name: `site.zip`, path: `drops/site.zip`, type: `file` };
        expect(labels(entryMenuItems(input({ target: zip })))).toEqual([
            `New File`,
            `New Folder`,
            `—`,
            `Extract`,
            `Rename`,
            `Delete`,
            `—`,
            `Cut`,
            `Copy`,
            `Download`,
        ]);
        expect(labels(entryMenuItems(input({ target: zip, multi: true, count: 2 })))).not.toContain(`Extract`);
        expect(labels(entryMenuItems(input({ target: { ...zip, name: `site.7z`, path: `drops/site.7z` } })))).not.toContain(`Extract`);
        // A folder can be named like an archive without being one.
        expect(labels(entryMenuItems(input({ target: { ...dir, name: `site.zip`, path: `site.zip` } })))).not.toContain(`Extract`);
    });

    it(`seats each surface's own rows where it asked`, () => {
        const head = [{ label: `Open` }];
        const lead = [{ label: `Open management panel` }];
        const tail = [{ label: `Collapse Folders` }];
        expect(labels(entryMenuItems(input({ target: dir, head, lead, tail })))).toEqual([
            `Open`,
            `—`,
            `New File`,
            `New Folder`,
            `Open management panel`,
            `Open Terminal`,
            `—`,
            `Rename`,
            `Delete`,
            `—`,
            `Cut`,
            `Copy`,
            `Download as ZIP`,
            `—`,
            `Collapse Folders`,
        ]);
    });

    it(`keeps a read-only member to the readable rows and says why`, () => {
        const items = entryMenuItems(input({ canEdit: false, lead: [{ label: `Open management panel` }] }));
        expect(labels(items)).toEqual([`Open management panel`, `—`, `Download`, `—`, `Read-only: changing files needs writer access`]);
        expect(items.at(-1)?.disabled).toBe(true);
    });

    it(`does not lead a read-only menu with a separator when nothing else is readable`, () => {
        const items = entryMenuItems(input({ canEdit: false }));
        expect(labels(items)).toEqual([`Download`, `—`, `Read-only: changing files needs writer access`]);
        expect(items[0]?.separator).not.toBe(true);
    });

    it(`inside an archive keeps the read verbs and the one that gets something out`, () => {
        const items = entryMenuItems(input({ archived: true, head: [{ label: `Open` }], tail: [{ label: `Collapse Folders` }] }));
        expect(labels(items)).toEqual([
            `Open`,
            `—`,
            `Copy`,
            `Download`,
            `—`,
            `Collapse Folders`,
            `—`,
            `Inside an archive: extract it to change anything`,
        ]);
        expect(items.at(-1)?.disabled).toBe(true);
    });

    it(`counts a bulk copy out of an archive, and offers nothing on its background`, () => {
        expect(labels(entryMenuItems(input({ archived: true, multi: true, count: 3 })))).toContain(`Copy 3 items`);
        // Nothing lands in an archive, so its background has no create to offer.
        expect(labels(entryMenuItems(input({ archived: true, target: undefined, clipboardFull: true })))).toEqual([
            `Inside an archive: extract it to change anything`,
        ]);
    });

    it(`drops a folder's own rows inside an archive: they are about the workspace, not a copy of one`, () => {
        expect(labels(entryMenuItems(input({ archived: true, target: dir, lead: [{ label: `Open management panel` }] })))).not.toContain(
            `Open management panel`,
        );
    });

    it(`offers Download to anything readable, saying when it comes zipped, and never on the background`, () => {
        expect(labels(entryMenuItems(input({ target: dir })))).toContain(`Download as ZIP`);
        expect(labels(entryMenuItems(input({ target: dir, canEdit: false })))).toContain(`Download as ZIP`);
        expect(labels(entryMenuItems(input({ archived: true, multi: true, count: 2 })))).toContain(`Download 2 items as ZIP`);
        expect(labels(entryMenuItems(input({ target: undefined }))).some((label) => label.startsWith(`Download`))).toBe(false);
        expect(labels(entryMenuItems(input({ target: undefined, canEdit: false }))).some((label) => label.startsWith(`Download`))).toBe(false);
        const spec = input({ multi: true, count: 4 });
        entryMenuItems(spec)
            .find((item) => item.label === `Download 4 items as ZIP`)
            ?.command?.({} as never);
        expect(spec.verbs.download).toHaveBeenCalledTimes(1);
    });

    it(`explains a locked entry and offers nothing else`, () => {
        const items = entryMenuItems(input({ locked: true }));
        expect(labels(items)).toEqual([`Kept private by the sandbox`]);
        expect(items[0]?.disabled).toBe(true);
    });

    it(`runs the closure behind a verb`, () => {
        const spec = input();
        const remove = entryMenuItems(spec).find((item) => item.label === `Delete`);
        remove?.command?.({ originalEvent: new Event(`click`), item: remove });
        expect(spec.verbs.remove).toHaveBeenCalledTimes(1);
    });

    // What the desktop app's sidecar answers for a folder on this computer: its reads, and none of the verbs' routes.
    const FOLDER: ReadonlySet<string> = new Set([
        `workspace.tree`,
        `workspace.children`,
        `workspace.file`,
        `system.events`,
        `POST /workspace/upload`,
    ]);
    const zip: WorkspaceTreeEntry = { name: `site.zip`, path: `drops/site.zip`, type: `file` };

    it(`leaves out every verb whose route the backend does not serve, and keeps what it does`, () => {
        const serves = (route: string): boolean => FOLDER.has(route);
        expect(labels(entryMenuItems(input({ target: zip, serves })))).toEqual([`New File`, `—`, `Download`]);
        expect(labels(entryMenuItems(input({ target: dir, barren: true, serves, tail: [{ label: `Collapse Folders` }] })))).toEqual([
            `New File`,
            `—`,
            `Keep folder`,
            `—`,
            `Collapse Folders`,
        ]);
        expect(labels(entryMenuItems(input({ multi: true, count: 2, serves })))).toEqual([`New File`]);
        expect(labels(entryMenuItems(input({ canEdit: false, target: dir, serves })))).toEqual([`Read-only: changing files needs writer access`]);
        expect(labels(entryMenuItems(input({ archived: true, serves })))).toEqual([
            `Download`,
            `—`,
            `Inside an archive: extract it to change anything`,
        ]);
    });

    it(`keeps every verb for a daemon that serves the whole contract`, () => {
        const daemon: ReadonlySet<string> = new Set(SANDBOX_ROUTE_NAMES);
        // The routes the menu gates on are this build's own names, or a daemon level with it would lose the rows.
        expect([...Object.values(VERB_ROUTES), ZIP_ROUTE].filter((route) => !daemon.has(route))).toEqual([]);
        expect(labels(entryMenuItems(input({ target: zip, serves: (route) => daemon.has(route) })))).toEqual([
            `New File`,
            `New Folder`,
            `—`,
            `Extract`,
            `Rename`,
            `Delete`,
            `—`,
            `Cut`,
            `Copy`,
            `Download`,
        ]);
        expect(labels(entryMenuItems(input({ target: dir, serves: (route) => daemon.has(route) })))).toContain(`Open Terminal`);
    });
    // A folder on this computer (the desktop app's local window) is handed no terminal, no unpacking and no download,
    // and has one verb a sandbox's surface has not: asking an agent about a file.
    const localVerbs = (): EntryVerbs => ({ ...verbs(), extract: undefined, openTerminal: undefined, download: undefined, ask: jest.fn() });
    const zipFile: WorkspaceTreeEntry = { name: `site.zip`, path: `drops/site.zip`, type: `file` };

    it(`leaves out every verb whose seam the surface was not handed, whatever the backend serves`, () => {
        expect(labels(entryMenuItems(input({ target: zipFile, verbs: localVerbs() })))).toEqual([
            `Ask an agent about this`,
            `—`,
            `New File`,
            `New Folder`,
            `—`,
            `Rename`,
            `Delete`,
            `—`,
            `Cut`,
            `Copy`,
        ]);
        // Keep folder, Paste and the surface's own rows stay: they need nothing the window lacks.
        expect(
            labels(
                entryMenuItems(input({ target: dir, barren: true, clipboardFull: true, verbs: localVerbs(), tail: [{ label: `Collapse Folders` }] })),
            ),
        ).toEqual([`New File`, `New Folder`, `—`, `Rename`, `Keep folder`, `Delete`, `—`, `Cut`, `Copy`, `Paste`, `—`, `Collapse Folders`]);
        expect(labels(entryMenuItems(input({ multi: true, count: 3, verbs: localVerbs() })))).toEqual([
            `New File`,
            `New Folder`,
            `—`,
            `Delete 3 items`,
            `—`,
            `Cut 3 items`,
            `Copy 3 items`,
        ]);
        expect(labels(entryMenuItems(input({ archived: true, verbs: localVerbs() })))).toEqual([
            `Copy`,
            `—`,
            `Inside an archive: extract it to change anything`,
        ]);
    });

    it(`asks an agent about the one file right-clicked, first, and a reader may too`, () => {
        const spec = input({ verbs: localVerbs() });
        const ask = entryMenuItems(spec).find((item) => item.label === `Ask an agent about this`);
        ask?.command?.({ originalEvent: new Event(`click`), item: ask });
        expect(spec.verbs.ask).toHaveBeenCalledTimes(1);
        expect(labels(entryMenuItems(input({ canEdit: false, verbs: localVerbs() })))).toEqual([
            `Ask an agent about this`,
            `—`,
            `Read-only: changing files needs writer access`,
        ]);
        // Never about a folder, a selection, the background, or an entry inside an archive, which is no file on disk.
        const elsewhere: readonly Partial<EntryMenuInput>[] = [{ target: dir }, { multi: true, count: 2 }, { target: undefined }, { archived: true }];
        expect(elsewhere.map((over) => labels(entryMenuItems(input({ ...over, verbs: localVerbs() }))).includes(`Ask an agent about this`))).toEqual([
            false,
            false,
            false,
            false,
        ]);
        // Nor on a surface with no way to an agent.
        expect(labels(entryMenuItems(input()))).not.toContain(`Ask an agent about this`);
    });
});
