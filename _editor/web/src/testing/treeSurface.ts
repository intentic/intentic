import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { noticeOf, type NoticeModel } from "@intentic/ui/async";
import { mock } from "bun:test";
import { computed, effectScope, ref, shallowRef } from "vue";
import type { DeleteBatch } from "../features/workspace/explorer/deleteUndo";
import { barrenChainOf, barrenChildren, barrenRoots } from "../features/workspace/explorer/emptyDirs";
import type { RowAction } from "../features/workspace/explorer/rowActions";
import type { DroppedFile } from "../features/workspace/explorer/transfer/dropEntries";
import { indexEntries } from "../features/workspace/explorer/tree/treeRows";
import { useTreeDelete } from "../features/workspace/explorer/tree/useTreeDelete";
import { useInlineEdit, useTreeEdits } from "../features/workspace/explorer/tree/useTreeEdits";
import { type TreeMenuHost, useTreeMenu } from "../features/workspace/explorer/tree/useTreeMenu";
import { useTreeRows } from "../features/workspace/explorer/tree/useTreeRows";
import { useTreeRules } from "../features/workspace/explorer/tree/useTreeRules";
import { useTreeSelection } from "../features/workspace/explorer/tree/useTreeSelection";
import { useTreeTransfer } from "../features/workspace/explorer/tree/useTreeTransfer";

// A file surface wired as WorkspaceTree.vue wires it, over fakes of its two seams: the store's daemon calls, empty folders.

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf(`/`)));
export const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: nameOf(path),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});
export const file = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `file` });

// The listing with `entry` placed in its parent (or at the root), and with `gone` taken out wherever it was.
const relisted = (nodes: readonly WorkspaceTreeEntry[], entry: WorkspaceTreeEntry | undefined, gone?: string): WorkspaceTreeEntry[] => {
    const at = entry === undefined ? undefined : parentOf(entry.path);
    const kept = nodes
        .filter((node) => node.path !== gone)
        .map((node) =>
            node.children === undefined ? node : { ...node, children: relisted(node.children, node.path === at ? undefined : entry, gone) },
        );
    const home = entry !== undefined && at !== `` && kept.find((node) => node.path === at);
    if (home) {
        return kept.map((node) => (node === home ? { ...node, children: [...(node.children ?? []), entry] } : node));
    }
    return entry !== undefined && at === `` ? [...kept, entry] : kept;
};

// The settled empty-folder list (useEmptyDirs, minus its settle clock).
export const emptyDirsOver = (barren: readonly string[]) => {
    const settled = shallowRef(barren);
    return {
        settled,
        emptyDirs: {
            isBarren: (path: string) => settled.value.includes(path),
            roots: computed(() => barrenRoots(settled.value, new Set(settled.value))),
            chainOf: (path: string) => barrenChainOf(path, barrenChildren(settled.value)),
        },
    };
};

export interface StoreOptions {
    readonly canWrite?: boolean;
    // Park every daemon answer until `release()`, so a test can read the surface while a write is in flight.
    readonly park?: boolean;
    // Paths the daemon will not write: the call answers, and the listing never gains them.
    readonly refused?: ReadonlySet<string>;
}

// useWorkspaceTree's writes and listings: a write answers after `park`, and a create or a rename relists the tree.
export const fakeTreeStore = (listing: readonly WorkspaceTreeEntry[], { canWrite = true, park = false, refused = new Set() }: StoreOptions = {}) => {
    const calls: string[] = [];
    let release = (): void => undefined;
    const answered = park
        ? new Promise<void>((resolve) => {
              release = resolve;
          })
        : Promise.resolve();
    const tree = shallowRef<readonly WorkspaceTreeEntry[]>(listing);
    const lazyChildren = shallowRef(new Map<string, readonly WorkspaceTreeEntry[]>());
    const land = async (what: string, path: string, entry?: WorkspaceTreeEntry, gone?: string): Promise<void> => {
        await answered;
        calls.push(what);
        if (!refused.has(path)) {
            tree.value = relisted(tree.value, entry, gone);
        }
    };
    const actionError = ref<NoticeModel | undefined>(undefined);
    const entriesByPath = computed(() => indexEntries(tree.value, (entry) => entry.children ?? lazyChildren.value.get(entry.path) ?? []));
    const store = {
        tree,
        barren: shallowRef<readonly string[]>([]),
        entriesByPath,
        entry: (path: string | undefined): WorkspaceTreeEntry | undefined => (path === undefined ? undefined : entriesByPath.value.get(path)),
        listingOf: (at: string): readonly WorkspaceTreeEntry[] | undefined =>
            at === `` ? tree.value : (entriesByPath.value.get(at)?.children ?? lazyChildren.value.get(at)),
        lazyChildren,
        lazyHidden: shallowRef(new Map<string, number>()),
        expanded: shallowRef<ReadonlySet<string>>(new Set()),
        clipboard: shallowRef<{ readonly mode: "copy" | "cut"; readonly paths: readonly string[] } | undefined>(undefined),
        actionError,
        canEditFiles: computed(() => canWrite),
        refuseWrite: mock((): boolean => {
            if (!canWrite) {
                actionError.value = noticeOf(`Changing files needs writer access. Yours is read-only here.`);
            }
            return !canWrite;
        }),
        run: mock(async (task: () => Promise<void>, wrote: string): Promise<void> => {
            calls.push(`run: ${wrote}`);
            await task();
        }),
        moveEntry: mock((from: string, to: string): Promise<void> => land(`move ${from} → ${to}`, to, file(to), from)),
        createFile: mock((path: string): Promise<void> => land(`write ${path}`, path, file(path))),
        createDir: mock((path: string): Promise<void> => land(`mkdir ${path}`, path, dir(path, []))),
        // Each path goes to the trash under an id named after it, so a test can tell which batch a receipt's Undo holds.
        removeEntries: mock(async (paths: readonly string[]): Promise<DeleteBatch> => {
            await answered;
            calls.push(`delete ${paths.join(`, `)}`);
            return { entries: paths.map((path) => ({ path, type: `file`, trashed: `trash:${path}` })) };
        }),
        copyEntries: mock(async (pairs: readonly { from: string; to: string }[]): Promise<void> => {
            await answered;
            calls.push(`copy ${pairs.map((pair) => `${pair.from} → ${pair.to}`).join(`, `)}`);
        }),
        moveIntoMany: mock(async (sources: readonly string[], into: string): Promise<void> => {
            await answered;
            calls.push(`move ${sources.join(`, `)} into ${into}`);
        }),
        extractEntry: mock(async (path: string): Promise<string> => {
            await answered;
            calls.push(`extract ${path}`);
            return `docs/bundle`;
        }),
        // A folder the walk skipped holds one `main.ts` once asked.
        loadChildren: mock(async (path: string): Promise<void> => {
            calls.push(`list ${path}`);
            lazyChildren.value = new Map([...lazyChildren.value, [path, [file(`${path}/main.ts`)]]]);
        }),
        collapseAll: mock((): void => {
            store.expanded.value = new Set();
        }),
    };
    return { store, calls, release: () => release() };
};

export interface SurfaceOptions extends StoreOptions {
    // The folder `listing` is the contents of.
    readonly rootDir?: string;
    readonly barren?: readonly string[];
    readonly rowActions?: (dir: string) => readonly RowAction[];
    readonly frame?: TreeMenuHost[`frame`];
    // Whether package.json folds its sibling files (the explorer's file-nesting preference).
    readonly nesting?: boolean;
}

// The tree's composables over one listing, the way WorkspaceTree.vue builds them; the surface's element is in the DOM.
export const treeSurface = (
    listing: readonly WorkspaceTreeEntry[],
    { rootDir = ``, barren = [], rowActions = () => [], frame = () => ({}), nesting = false, ...options }: SurfaceOptions = {},
) => {
    const { store, calls, release } = fakeTreeStore(listing, options);
    const { settled, emptyDirs } = emptyDirsOver(barren);
    const el = document.createElement(`div`);
    document.body.append(el);
    const uploads = {
        enqueue: mock((at: string, dropped: readonly DroppedFile[]): Promise<void> => Promise.resolve()),
        enqueueFromDataTransfer: mock((at: string, transfer: DataTransfer): void => undefined),
    };
    const say = mock((message: string, undo?: () => void | Promise<void>) => [message, undo]);
    // A delete's receipt, recorded with the batch its Undo would take back.
    const sayDeleted = mock((receipt: string, batch: DeleteBatch) => [receipt, batch]);
    const surface = effectScope().run(() => {
        const rows = useTreeRows({
            tree: () => store.tree.value,
            rootDir: () => rootDir,
            rootHidden: () => 0,
            filter: () => ``,
            filters: ref({ showIgnored: true, hideTests: false, hideTechnical: false }),
            nesting: ref(nesting),
            store,
            emptyDirs,
        });
        const { byPath, targetDir, openLanding, openNest } = rows;
        const rules = useTreeRules({ byPath, store });
        const selecting = useTreeSelection({ selectedPath: () => undefined, order: rows.orderedPaths });
        const inline = useInlineEdit((path) => byPath.value.has(path));
        const edits = useTreeEdits({
            inline,
            byPath,
            rules,
            targetDir,
            openLanding,
            selectSingle: selecting.selectSingle,
            focusLead: async () => {
                calls.push(`focus`);
            },
            store,
            openCreated: (path) => calls.push(`opened ${path}`),
        });
        const deleting = useTreeDelete({ byPath, targetDir, rules, emptyDirs, selecting, store, say, sayDeleted });
        const transfer = useTreeTransfer({
            tree: () => store.tree.value,
            rootDir: () => rootDir,
            byPath,
            childrenOf: rows.childrenOf,
            targetDir,
            openLanding,
            openNest,
            rules,
            selecting,
            inline,
            el: ref(el),
            store,
            uploads,
            say,
        });
        const menu = useTreeMenu({
            rootDir: () => rootDir,
            rowActions,
            isBarren: emptyDirs.isBarren,
            rules,
            selecting,
            store,
            frame,
            beginCreate: edits.beginCreate,
            beginRename: edits.beginRename,
            extract: transfer.extract,
            keepFolder: deleting.keepFolder,
            requestDelete: deleting.requestDelete,
            stage: transfer.stage,
            paste: transfer.paste,
            openTerminal: () => undefined,
        });
        return { rows, rules, selecting, inline, edits, deleting, transfer, menu };
    })!;
    // Marks `paths` selected, the last leading, as a run of Ctrl-clicks would.
    const select = (...paths: string[]): void => {
        surface.selecting.selection.value = new Set(paths);
        surface.selecting.lead.value = paths.at(-1) ?? null;
    };
    return { ...surface, store, calls, release, settled, uploads, say, sayDeleted, el, select };
};
