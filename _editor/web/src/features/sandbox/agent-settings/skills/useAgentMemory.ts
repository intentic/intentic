import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { MEMORY_FILE } from "@intentic/constants";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { mergeMemory } from "../../../extensions/memoryImport";
import { useWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";

// Module-level: the memory editor and import group share one file's draft and reload after a merge. Sandbox-scoped:
// the file is one sandbox's, and a draft carried across a switch would be saved into the next one's.
const draft = sandboxRef(() => ``);
const onDisk = sandboxRef<string | undefined>(() => undefined);
// Whether the file is there at all: a missing one reads as empty, and "Open file" on it landed on the workspace root.
const present = sandboxRef(() => false);
const saving = sandboxRef(() => false);
const editorError = sandboxRef<NoticeModel | undefined>(() => undefined);
const importError = sandboxRef<NoticeModel | undefined>(() => undefined);
const importText = sandboxRef(() => ``);
const importing = sandboxRef(() => false);

export function useAgentMemory() {
    const { readFile, saveText } = useWorkspaceTree();

    const load = async (): Promise<void> => {
        editorError.value = undefined;
        onDisk.value = undefined;
        const current = sandboxScopeGuard();
        try {
            const read = await readFile(MEMORY_FILE);
            const text = read ?? ``;
            if (current()) {
                present.value = read !== undefined;
                onDisk.value = text;
                draft.value = text;
            }
        } catch (caught) {
            if (current()) {
                editorError.value = noticeFrom(caught, t(`sandbox.useAgentMemory.couldntRead`, { file: MEMORY_FILE }));
            }
        }
    };

    // A save or an import finishing after a switch wrote the box left behind: nothing of it is this box's to show.
    const commit = async (text: string): Promise<void> => {
        saving.value = true;
        editorError.value = undefined;
        const current = sandboxScopeGuard();
        try {
            await saveText(MEMORY_FILE, text);
            if (current()) {
                present.value = true;
                onDisk.value = text;
            }
        } catch (caught) {
            if (current()) {
                editorError.value = noticeFrom(caught, t(`sandbox.useAgentMemory.couldntSave`, { file: MEMORY_FILE }));
            }
        } finally {
            if (current()) {
                saving.value = false;
            }
        }
    };

    const importMemory = async (): Promise<void> => {
        const text = importText.value.trim();
        if (text === `` || importing.value) {
            return;
        }
        importing.value = true;
        importError.value = undefined;
        const current = sandboxScopeGuard();
        try {
            const held = (await readFile(MEMORY_FILE)) ?? ``;
            await saveText(MEMORY_FILE, mergeMemory(held, text));
            if (!current()) {
                return;
            }
            importText.value = ``;
            await load();
        } catch (caught) {
            if (current()) {
                importError.value = noticeFrom(caught, t(`sandbox.useAgentMemory.couldntSaveMemory`));
            }
        } finally {
            if (current()) {
                importing.value = false;
            }
        }
    };

    return { draft, onDisk, present, saving, editorError, importError, importText, importing, load, commit, importMemory };
}
