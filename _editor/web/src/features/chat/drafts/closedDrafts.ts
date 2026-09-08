import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { onChatNote, postChatNote } from "../run/chatChannel";
import { readStoredTabs, type StoredTab } from "../tabs/tabSnapshot";
import { useSandbox } from "../../sandbox/client/useSandbox";

// Composer drafts (words, staged attachments, queued messages) a chat close would otherwise lose, kept per
// browser (not per window) in localStorage and broadcast over chatChannel so every window's board reflects them
// immediately. Scoped per sandbox; an entry leaves only when claimed (reopened) or dismissed, never by expiry.

// Max closed drafts kept per sandbox; oldest evicted on overflow.
const KEEP = 30;

const storageKey = (sandboxId: string): string => `intentic.closedDrafts.${sandboxId}`;

const read = (sandboxId: string | undefined): readonly StoredTab[] => {
    if (sandboxId === undefined) {
        return [];
    }
    try {
        const raw = localStorage.getItem(storageKey(sandboxId));
        return raw === null ? [] : readStoredTabs(raw);
    } catch {
        // Storage unavailable or unreadable: treated as no drafts set aside.
        return [];
    }
};

const write = (sandboxId: string | undefined, tabs: readonly StoredTab[]): void => {
    if (sandboxId === undefined) {
        return;
    }
    try {
        localStorage.setItem(storageKey(sandboxId), JSON.stringify({ tabs }));
    } catch {
        // Unavailable or over quota; the in-memory set still holds until reload.
    }
};

// The set this window is holding, newest first, for the sandbox it is pointed at.
const kept = shallowRef<readonly StoredTab[]>([]);

/** The chats closed with words still in them, newest first; the board draws them like any open tab's draft. */
export const closedDrafts: ComputedRef<readonly StoredTab[]> = computed(() => kept.value);

const { activeSandboxId } = useSandbox();

// Reloads on every sandbox switch; drafts are per-sandbox and must not leak across boxes.
watch(activeSandboxId, (sandboxId) => (kept.value = read(sandboxId)), { immediate: true });

// Publishes the whole set, never a patch: the last note wins, so a window that missed one is corrected by
// the next.
const publish = (tabs: readonly StoredTab[]): void => {
    kept.value = tabs;
    write(activeSandboxId.value, tabs);
    postChatNote({ kind: `closed-drafts`, tabs });
};

/** Sets a closing chat's words aside; called only for a tab that holds something unsent. Not a history of tabs. */
export const keepClosedDraft = (tab: StoredTab): void => {
    publish([tab, ...kept.value.filter((entry) => entry.conversationId !== tab.conversationId)].slice(0, KEEP));
};

// Returns and drops the named entries: the words are about to live in a composer again, so no duplicate can
// go stale. Claimed once per reveal, so a multi-tab reveal writes and broadcasts the remainder once.
export const claimClosedDrafts = (conversationIds: readonly string[]): readonly StoredTab[] => {
    const wanted = new Set(conversationIds);
    const found = kept.value.filter((entry) => wanted.has(entry.conversationId));
    if (found.length > 0) {
        publish(kept.value.filter((entry) => !wanted.has(entry.conversationId)));
    }
    return found;
};

/** Drops an entry without reopening it, for the board's × that closes the conversation for good. */
export const forgetClosedDraft = (conversationId: string): void => {
    if (kept.value.some((entry) => entry.conversationId === conversationId)) {
        publish(kept.value.filter((entry) => entry.conversationId !== conversationId));
    }
};

// Another window's set, arriving here; the channel has already dropped another sandbox's.
onChatNote(`closed-drafts`, (note) => {
    kept.value = note.tabs;
});

// Guards against a hot update re-running this module into an orphaned instance.
reloadOnHotUpdate(import.meta);
