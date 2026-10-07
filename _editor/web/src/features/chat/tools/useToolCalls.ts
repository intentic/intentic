import type { Ref } from "vue";
import { t } from "@intentic/ui/i18n";
import { definePreference } from "@intentic/ui/preference";

const STORAGE_KEY = `ui-chat-show-tool-calls`;

// Whether a transcript shows tool calls inline, or folds each run behind one node on the spine (transcript/asides/ChatTurnAsides.vue). An
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

// What a press on the switch did to the chat it was pressed in, said beside it for a moment (ChatToolCallsToggle): in a
// chat holding one call, or none, the press changed one small row or nothing, and read as a switch that does nothing.
export const toolCallsNote = (shown: boolean, calls: number): string => {
    if (calls === 0) {
        return t(`chat.chatToolCallsToggle.noneYet`);
    }
    return shown ? t(`chat.chatToolCallsToggle.showing`, { count: calls }, calls) : t(`chat.chatToolCallsToggle.hidden`, { count: calls }, calls);
};
