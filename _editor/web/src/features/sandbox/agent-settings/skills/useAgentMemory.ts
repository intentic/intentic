import { MEMORY_FILE } from "@intentic/constants";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { ref } from "vue";
import { mergeMemory } from "../../../extensions/memoryImport";
import { useWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";

// Module-level: the memory editor and import group share one file's draft and reload after a merge.
const draft = ref(``);
const onDisk = ref<string | undefined>(undefined);
const saving = ref(false);
const editorError = ref<NoticeModel | undefined>(undefined);
const importError = ref<NoticeModel | undefined>(undefined);
const importText = ref(``);
const importing = ref(false);

export function useAgentMemory() {
    const { readFile, saveText } = useWorkspaceTree();

    const load = async (): Promise<void> => {
        editorError.value = undefined;
        onDisk.value = undefined;
        try {
            const text = (await readFile(MEMORY_FILE)) ?? ``;
            onDisk.value = text;
            draft.value = text;
        } catch (caught) {
            editorError.value = noticeFrom(caught, `Couldn't read ${MEMORY_FILE}.`);
        }
    };

    const commit = async (text: string): Promise<void> => {
        saving.value = true;
        editorError.value = undefined;
        try {
            await saveText(MEMORY_FILE, text);
            onDisk.value = text;
        } catch (caught) {
            editorError.value = noticeFrom(caught, `Couldn't save ${MEMORY_FILE}.`);
        } finally {
            saving.value = false;
        }
    };

    const importMemory = async (): Promise<void> => {
        const text = importText.value.trim();
        if (text === `` || importing.value) {
            return;
        }
        importing.value = true;
        importError.value = undefined;
        try {
            const current = (await readFile(MEMORY_FILE)) ?? ``;
            await saveText(MEMORY_FILE, mergeMemory(current, text));
            importText.value = ``;
            await load();
        } catch (caught) {
            importError.value = noticeFrom(caught, `Couldn't save memory.`);
        } finally {
            importing.value = false;
        }
    };

    return { draft, onDisk, saving, editorError, importError, importText, importing, load, commit, importMemory };
}
