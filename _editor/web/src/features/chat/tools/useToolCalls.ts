import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

const STORAGE_KEY = `ui-chat-show-tool-calls`;

// Whether a transcript shows tool calls inline, or folds each turn's run behind one mark (see chat/ChatToolRun.vue). An
// account-wide preference, like useFileNesting: it governs how every chat's transcript reads. Hidden by default;
// turning it on only stops runs from folding, it doesn't change how a call renders.

const showToolCalls: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

export function useToolCalls() {
    return { showToolCalls };
}
