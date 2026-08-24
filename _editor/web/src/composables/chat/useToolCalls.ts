import { type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

const STORAGE_KEY = `ui-chat-show-tool-calls`;

/* Whether a transcript draws its tool calls, or hides each turn's run behind a single mark (see
 * chat/ChatToolRun.vue). An account preference (composables/preference.ts), mirroring useFileNesting, one
 * reading for every chat in every pane AND every window, because it is a statement about how transcripts should
 * read rather than about one of them. That last part is why it is here rather than in a ref of its own: the chat
 * is the panel most likely to be popped out, so this is the setting most likely to be flipped on the settings
 * page while the transcript it governs is on another screen.
 *
 * Hidden by default. Watching an agent work is a mode, and the people who want it want it always; everyone else
 * is here for the answer, and pays a screenful of rows a turn for calls they would never have opened. Turned
 * on, nothing about a call's rendering changes, the runs simply stop being folded. */

const showToolCalls: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

export function useToolCalls() {
    return { showToolCalls };
}
