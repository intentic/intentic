import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { MEMORY_FILE } from "@intentic/constants";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { mergeMemory } from "../../../extensions/memoryImport";
import { useWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";

// Module-level: the memory editor and import group share one file's draft and reload after a merge. Sandbox-scoped:
// the file is one sandbox's, and a draft carried across a switch would be saved into the next one's.
const draft = sandboxRef(() => ``);
const onDisk = sandboxRef<string | undefined>(() => undefined);
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
            const text = (await readFile(MEMORY_FILE)) ?? ``;
            if (current()) {
                onDisk.value = text;
                draft.value = text;
            }
        } catch (caught) {
            if (current()) {
                editorError.value = noticeFrom(caught, `Couldn't read ${MEMORY_FILE}.`);
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
                onDisk.value = text;
            }
        } catch (caught) {
            if (current()) {
                editorError.value = noticeFrom(caught, `Couldn't save ${MEMORY_FILE}.`);
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
                importError.value = noticeFrom(caught, `Couldn't save memory.`);
            }
        } finally {
            if (current()) {
                importing.value = false;
            }
        }
    };

    return { draft, onDisk, saving, editorError, importError, importText, importing, load, commit, importMemory };
}
