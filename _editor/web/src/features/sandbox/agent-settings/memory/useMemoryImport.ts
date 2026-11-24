import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { MEMORY_FILE } from "@intentic/constants";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { hasImportedMemory, mergeMemory } from "../../../extensions/memoryImport";
import { useWorkspaceTree } from "../../../../models/workspace/tree/useWorkspaceTree";

// Bringing another assistant's memory into the workspace's own AGENTS.md. Module-level, so a pasted answer survives the
// dialog being closed and opened again; sandbox-scoped, since it would otherwise be merged into the next sandbox's file.
const answer = sandboxRef(() => ``);
const importing = sandboxRef(() => false);
const failure = sandboxRef<NoticeModel | undefined>(() => undefined);
// Whether the file already holds an earlier import, which the next one replaces rather than adds to.
const replaces = sandboxRef(() => false);

export function useMemoryImport() {
    const { readFile, saveText } = useWorkspaceTree();

    const look = async (): Promise<void> => {
        const current = sandboxScopeGuard();
        try {
            const text = (await readFile(MEMORY_FILE)) ?? ``;
            if (current()) {
                replaces.value = hasImportedMemory(text);
            }
        } catch {
            // allow(silent-catch): only decides a hint; the merge reads the file again and reports its own failure.
        }
    };

    // True once the answer is in the file; a failure is said beside the field instead.
    const importMemory = async (): Promise<boolean> => {
        const text = answer.value.trim();
        if (text === `` || importing.value) {
            return false;
        }
        importing.value = true;
        failure.value = undefined;
        const current = sandboxScopeGuard();
        try {
            const before = (await readFile(MEMORY_FILE)) ?? ``;
            await saveText(MEMORY_FILE, mergeMemory(before, text));
            if (!current()) {
                return false;
            }
            answer.value = ``;
            replaces.value = true;
            return true;
        } catch (caught) {
            if (current()) {
                failure.value = noticeFrom(caught, t(`sandbox.useAgentMemory.couldntSaveMemory`));
            }
            return false;
        } finally {
            if (current()) {
                importing.value = false;
            }
        }
    };

    return { answer, importing, failure, replaces, look, importMemory };
}
