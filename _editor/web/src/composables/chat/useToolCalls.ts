import { ref, watch, type Ref } from "vue";

const STORAGE_KEY = `ui-chat-show-tool-calls`;

/* Whether a transcript draws its tool calls, or hides each turn's run behind a single mark (see
 * chat/ChatToolRun.vue). A module-level singleton persisted to localStorage, mirroring useFileNesting — one
 * reading for every chat in every pane, because it is a statement about how transcripts should read rather than
 * about one of them.
 *
 * Hidden by default. Watching an agent work is a mode, and the people who want it want it always; everyone else
 * is here for the answer, and pays a screenful of rows a turn for calls they would never have opened. Turned
 * on, nothing about a call's rendering changes — the runs simply stop being folded. */

const read = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) === `on`;
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
        return false;
    }
};

const showToolCalls: Ref<boolean> = ref(read());

// Persist every change (including direct writes from the Settings toggle), so no page needs a setter.
watch(showToolCalls, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value ? `on` : `off`);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useToolCalls() {
    return { showToolCalls };
}
