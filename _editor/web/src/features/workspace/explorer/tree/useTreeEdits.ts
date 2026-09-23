import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { computed, type Ref, ref, shallowRef, type VNode } from "vue";
import { newNameError } from "../entryNames";
import { noteUserCreatedDir } from "../useEmptyDirs";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import { advanceEdit, IDLE, type InlineEdit, type InlineEditEvent, type InlineWrite } from "./inlineEdit";
import type { useTreeRules } from "./useTreeRules";

// Naming in place: the inline field's state (inlineEdit.ts, made reactive) and what its gestures do to the tree. Both
// writes put their row up before the daemon answers, so the field is replaced by a real-looking row in the same frame.

// The field as reactive state: which one is open, what it holds, and the live check on a new entry's name.
export const useInlineEdit = (exists: (path: string) => boolean) => {
    const edit = shallowRef<InlineEdit>(IDLE);
    const draft = ref(``);
    // Live validation while typing (entryNames.ts); empty stays error-free, since an empty commit is a silent cancel.
    const createError = computed<string | undefined>(() =>
        edit.value.kind === `creating` ? newNameError(draft.value, edit.value.dir, exists) : undefined,
    );
    // An open field owns its keys and the clipboard's events.
    const editing = computed(() => edit.value.kind !== `idle`);
    // Moves the field, and answers the write the move asks for.
    const apply = (event: InlineEditEvent): InlineWrite | undefined => {
        const step = advanceEdit(edit.value, event);
        edit.value = step.edit;
        if (step.draft !== undefined) {
            draft.value = step.draft;
        }
        return step.write;
    };
    return { edit, draft, createError, editing, apply };
};

// Focuses and selects the field the moment it mounts; only one is ever rendered at a time.
export const focusField = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};

export interface TreeEditsHost {
    readonly inline: ReturnType<typeof useInlineEdit>;
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly rules: Pick<ReturnType<typeof useTreeRules>, "pending" | "refuseIn">;
    readonly targetDir: (path: string | null) => string;
    readonly openFolder: (dir: string) => void;
    readonly selectSingle: (path: string) => void;
    readonly focusLead: () => Promise<void>;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "run" | "moveEntry" | "createDir" | "createFile">;
    // A new file opens straight into edit mode, kept rather than previewed, so a later peek can't close it mid-type.
    readonly openCreated: (path: string) => void;
}

export const useTreeEdits = (host: TreeEditsHost) => {
    const { inline, rules, store } = host;

    const beginRename = (path: string): void => {
        if (isLockedWorkspacePath(path) || rules.pending(path) || rules.refuseIn(host.targetDir(path))) {
            return;
        }
        inline.apply({ kind: `rename`, path });
    };
    // The tree's own root draws no row to expand, so its phantom row sits in the preamble instead.
    const beginCreate = (dir: string, type: "file" | "dir"): void => {
        if (rules.refuseIn(dir)) {
            return;
        }
        host.openFolder(dir);
        inline.apply({ kind: `create`, dir, type });
    };

    // `moveEntry` swaps the rows before its first await, so the new name is on screen in this same frame; the selection
    // follows it, or the highlight would sit on a row that has just gone. A refusal puts both back.
    const renameTo = (from: string, to: string): void => {
        void store.run(() => store.moveEntry(from, to), `Couldn't rename that.`);
        host.selectSingle(to);
    };
    // Selection and focus land on the new row, up before the write's first await. A file's tab waits for the bytes: the
    // viewer reads the path it is given, and a read of a file the daemon hasn't written yet closes the tab that opened it.
    const createAt = async (path: string, type: "file" | "dir"): Promise<void> => {
        if (type === `dir`) {
            // A freshly created folder is exempt from barren marking until it gains content.
            noteUserCreatedDir(path);
        }
        const write =
            type === `dir`
                ? store.run(() => store.createDir(path), `Couldn't create that folder.`)
                : store.run(() => store.createFile(path), `Couldn't create that file.`);
        host.selectSingle(path);
        await host.focusLead();
        await write;
        // A folder opens nothing, and nor does a file refused and taken back off the tree.
        if (type === `dir` || (!rules.pending(path) && !host.byPath.value.has(path))) {
            return;
        }
        host.openCreated(path);
    };

    // Ends the field as the gesture says: Enter commits, Escape cancels, a blur commits unless the name was refused. The
    // field closes before any write is awaited, so a second Enter while it is in flight commits nothing.
    const endEdit = async (how: `commit` | `blur` | `cancel`): Promise<void> => {
        const write = inline.apply(
            how === `cancel` ? { kind: how } : { kind: how, draft: inline.draft.value, refused: inline.createError.value !== undefined },
        );
        if (write === undefined) {
            return;
        }
        if (write.kind === `rename`) {
            renameTo(write.from, write.to);
            return;
        }
        await createAt(write.path, write.type);
    };

    return { beginRename, beginCreate, endEdit };
};
