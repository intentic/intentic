import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { useWorkspaceTree } from "../../../../models/workspace/tree/useWorkspaceTree";

// One memory file as a document: read, written back whole on an explicit save (a half-typed rule going live would be
// read by the next turn), and what is typed held by path while it differs from the disk. Held at module level because a
// side tab put behind another is unmounted, and coming back to it must not lose a word; sandbox-scoped, since a draft
// carried across a switch would be saved into the next sandbox's file.
const held = sandboxRef<Readonly<Record<string, string>>>(() => ({}));

export interface MemoryDocument {
    readonly draft: Ref<string>;
    /** What the disk holds; undefined until the first read answers. A missing file reads as empty. */
    readonly onDisk: Ref<string | undefined>;
    readonly saving: Ref<boolean>;
    readonly error: Ref<NoticeModel | undefined>;
    /** Something is typed that is not saved yet. */
    readonly edited: ComputedRef<boolean>;
    readonly load: () => Promise<void>;
    readonly commit: (text: string) => Promise<void>;
}

export function useMemoryDocument(path: string): MemoryDocument {
    const { readFile, saveText } = useWorkspaceTree();
    const draft = ref(``);
    const onDisk = ref<string | undefined>();
    const saving = ref(false);
    const error = ref<NoticeModel | undefined>();

    const hold = (text: string | undefined): void => {
        const { [path]: _was, ...rest } = held.value;
        held.value = text === undefined ? rest : { ...rest, [path]: text };
    };

    // Read again whenever the file changes under the page (an import, the Workspace's editor, an approved rule); what
    // is typed and not saved stays on screen over it.
    const load = async (): Promise<void> => {
        error.value = undefined;
        const current = sandboxScopeGuard();
        try {
            const text = (await readFile(path)) ?? ``;
            if (current()) {
                onDisk.value = text;
                draft.value = held.value[path] ?? text;
            }
        } catch (caught) {
            if (current()) {
                error.value = noticeFrom(caught, t(`sandbox.useAgentMemory.couldntRead`, { file: path }));
            }
        }
    };

    // A save finishing after a switch wrote the box left behind: nothing of it is this box's to show.
    const commit = async (text: string): Promise<void> => {
        saving.value = true;
        error.value = undefined;
        const current = sandboxScopeGuard();
        try {
            await saveText(path, text);
            if (current()) {
                onDisk.value = text;
                hold(draft.value === text ? undefined : draft.value);
            }
        } catch (caught) {
            if (current()) {
                error.value = noticeFrom(caught, t(`sandbox.useAgentMemory.couldntSave`, { file: path }));
            }
        } finally {
            if (current()) {
                saving.value = false;
            }
        }
    };

    watch(draft, (text) => {
        if (onDisk.value !== undefined) {
            hold(text === onDisk.value ? undefined : text);
        }
    });

    return { draft, onDisk, saving, error, edited: computed(() => held.value[path] !== undefined), load, commit };
}
