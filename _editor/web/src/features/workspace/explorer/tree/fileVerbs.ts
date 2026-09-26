import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import type { Ref } from "vue";
import { type MultiSelect, useMultiSelect } from "../../../../lib/multiSelect";
import type { useNotifications } from "../../../../shell/notifications/notifications";
import type { useUploadQueue } from "../../files/upload/useUploadQueue";
import type { LandedEntry } from "../fileNesting";
import type { RowAction } from "../rowActions";
import type { DeleteBatch } from "../undo/deleteUndo";
import type { useEmptyDirs } from "../useEmptyDirs";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import { useTreeDelete } from "./useTreeDelete";
import { useInlineEdit, useTreeEdits } from "./useTreeEdits";
import { type TreeMenuHost, useTreeMenu } from "./useTreeMenu";
import { useTreeRules } from "./useTreeRules";
import { useTreeTransfer } from "./useTreeTransfer";

// Every verb a file surface offers (select, name in place, create, delete with undo, copy, cut, paste, drag, extract,
// the right-click menu), built once over one listing. The tree, the home and the tests' harness each call this rather
// than wiring the parts in `tree/` by hand, so a new verb is added here and nowhere else.

// What the verbs reach outside the surface: the daemon's files, the upload queue, the notices, the terminal panel.
// `fileVerbSeams.ts` hands out the app's own; a test passes fakes.
export interface FileVerbSeams {
    readonly store: Pick<
        ReturnType<typeof useWorkspaceTree>,
        | "actionError"
        | "refuseWrite"
        | "run"
        | "moveEntry"
        | "createDir"
        | "createFile"
        | "removeEntries"
        | "clipboard"
        | "copyEntries"
        | "moveIntoMany"
        | "extractEntry"
        | "loadChildren"
        | "canEditFiles"
    >;
    readonly uploads: Pick<ReturnType<typeof useUploadQueue>, "enqueue" | "enqueueFromDataTransfer">;
    readonly say: ReturnType<typeof useNotifications>["say"];
    // The receipt for a delete that landed, offering to take back exactly that batch.
    readonly sayDeleted: (receipt: string, batch: DeleteBatch) => void;
    // `dir` is workspace-relative.
    readonly openTerminal: (dir: string) => void;
}

export interface FileVerbsOptions {
    readonly seams: FileVerbSeams;
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    // The entries on screen in reading order: what Shift ranges over and select-all takes.
    readonly order: Readonly<Ref<readonly string[]>>;
    // A lead the page shares (the home's current entry); see `useMultiSelect`.
    readonly lead?: Ref<string | null>;
    // The listing the surface starts from: its folder, that folder's entries, and any entry's children.
    readonly rootDir: () => string;
    readonly tree: () => readonly WorkspaceTreeEntry[];
    readonly childrenOf: (entry: WorkspaceTreeEntry) => readonly WorkspaceTreeEntry[];
    // Where a verb aimed at `path` (null for the background) lands.
    readonly targetDir: (path: string | null) => string;
    // A surface that folds folders open (the tree) opens the one something lands in, and the package.json nest that
    // would fold it; one showing a single folder (the home) has nothing to open.
    readonly reveal?: {
        readonly openLanding: (dir: string, landed?: readonly LandedEntry[]) => void;
        readonly openNest: (dir: string, landed?: readonly LandedEntry[]) => void;
    };
    // Whether something that landed is on this surface to be marked; everything is, by default.
    readonly shows?: (path: string) => boolean;
    // Whether a name is taken, for the live check while one is typed; the listing's own entries by default.
    readonly exists?: (path: string) => boolean;
    // The surface element: a clipboard write goes through its window, so a popped-out surface writes to its own.
    readonly el: Readonly<Ref<HTMLElement | undefined>>;
    readonly emptyDirs: ReturnType<typeof useEmptyDirs>;
    // Where focus goes once the name field closes.
    readonly focusLead: () => Promise<void>;
    // A file just created opens straight into editing.
    readonly openCreated: (path: string) => void;
    // A folder's own rows (documents, personas, checks, management), none when the surface supplied no source.
    readonly rowActions: (dir: string) => readonly RowAction[];
    // The surface's own rows around the verbs: the home's Open first, the tree's Collapse Folders last.
    readonly frame: TreeMenuHost["frame"];
    // The folder a menu's New File or New Folder names into; the one the menu was opened on, by default.
    readonly createIn?: (dir: string) => string;
    // A surface where a row changing its own name is easy to miss (the phone's, under a thumb) names the new one once
    // the move lands.
    readonly sayRenamed?: boolean;
}

const nowhere = (): void => undefined;

export const createFileVerbs = (options: FileVerbsOptions) => {
    const { seams, byPath, targetDir } = options;
    const { store, say } = seams;
    const openLanding = options.reveal?.openLanding ?? nowhere;
    const shows = options.shows ?? ((): boolean => true);

    const rules = useTreeRules({ byPath, store });
    const multi = useMultiSelect(options.order, options.lead === undefined ? {} : { lead: options.lead });
    const selecting: MultiSelect = {
        ...multi,
        // Only what landed where this surface can show it is marked; the rest would be a selection nobody can see.
        selectLanded: (paths) => {
            const last = paths.at(-1);
            if (last === undefined || shows(last)) {
                multi.selectLanded(paths);
            }
        },
    };
    const inline = useInlineEdit(options.exists ?? ((path) => byPath.value.has(path)));
    const edits = useTreeEdits({
        inline,
        byPath,
        rules,
        targetDir,
        openLanding,
        selectSingle: selecting.selectSingle,
        focusLead: options.focusLead,
        store,
        openCreated: options.openCreated,
        renamed: options.sayRenamed === true ? (to) => say(t(`workspace.fileVerbs.renamedTo`, { name: basename(to) })) : nowhere,
    });
    const deleting = useTreeDelete({ byPath, targetDir, rules, emptyDirs: options.emptyDirs, selecting, store, say, sayDeleted: seams.sayDeleted });
    const transfer = useTreeTransfer({
        tree: options.tree,
        rootDir: options.rootDir,
        byPath,
        childrenOf: options.childrenOf,
        targetDir,
        openLanding,
        openNest: options.reveal?.openNest ?? nowhere,
        rules,
        selecting,
        inline,
        el: options.el,
        store,
        uploads: seams.uploads,
        say,
    });
    const createIn = options.createIn;
    const menu = useTreeMenu({
        rootDir: options.rootDir,
        rowActions: options.rowActions,
        isBarren: options.emptyDirs.isBarren,
        rules,
        selecting,
        store,
        frame: options.frame,
        beginCreate: createIn === undefined ? edits.beginCreate : (dir, type) => edits.beginCreate(createIn(dir), type),
        beginRename: edits.beginRename,
        extract: transfer.extract,
        keepFolder: deleting.keepFolder,
        requestDelete: deleting.requestDelete,
        stage: transfer.stage,
        paste: transfer.paste,
        // Read when the row is chosen, so a surface that never opens a terminal (a test's) need not supply one.
        openTerminal: (dir) => seams.openTerminal(dir),
    });

    return { rules, selecting, inline, edits, deleting, transfer, menu };
};

export type FileVerbs = ReturnType<typeof createFileVerbs>;
