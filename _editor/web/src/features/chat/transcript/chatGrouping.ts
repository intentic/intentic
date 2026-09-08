import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

// Two cuts of the same chat list, by lane or by persona: a mode switch, not a second list, since every chat has both at
// once. An account preference rather than a per-instance ref, since a floating window is a separate app copy that a ref
// update wouldn't reach.

export type ChatGrouping = "lane" | "persona";

const STORAGE_KEY = `ui-chat-grouping`;

// Anything but the stored "persona" reads as lanes, the default that's always valid since every chat has one.
const grouping: Ref<ChatGrouping> = definePreference<ChatGrouping>({
    key: STORAGE_KEY,
    read: (raw) => (raw === `persona` ? `persona` : `lane`),
    write: (value) => value,
});

const set = (value: ChatGrouping): void => {
    grouping.value = value;
};

export function useChatGrouping() {
    return { grouping, set };
}
