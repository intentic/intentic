import { sandboxShallowRef } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { onChatNote, postChatNote } from "../run/chatChannel";
import { readStoredTabs, type StoredTab } from "../tabs/tabSnapshot";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { closedDraftsKey, storedValue, storeJson } from "../../../app/storage/browserStorage";

// Composer drafts (words, staged attachments) a chat close would otherwise lose, kept per
// browser (not per window) in localStorage and broadcast over chatChannel so every window's board reflects them
// immediately. Scoped per sandbox; an entry leaves only when claimed (reopened) or dismissed, never by expiry, and all of
// them with the account on sign-out (lib/browserStorage.ts).

// Max closed drafts kept per sandbox; oldest evicted on overflow.
const KEEP = 30;

// Read through the tab strip's own parser (readStoredTabs), since a set-aside draft is a stored tab; storage that is off
// or unreadable reads as no drafts set aside.
const read = (sandboxId: string | undefined): readonly StoredTab[] => {
    const raw = sandboxId === undefined ? undefined : storedValue(closedDraftsKey(sandboxId));
    return raw === undefined ? [] : readStoredTabs(raw);
};

// Unavailable or over quota; the in-memory set still holds until reload.
const write = (sandboxId: string | undefined, tabs: readonly StoredTab[]): void => {
    if (sandboxId !== undefined) {
        storeJson(closedDraftsKey(sandboxId), { tabs });
    }
};

const { activeSandboxId } = useSandbox();

// The set this window is holding, newest first, for the sandbox it is pointed at: drafts are per-sandbox and must not
// leak across boxes, so each switch reads the incoming one's back.
const kept = sandboxShallowRef<readonly StoredTab[]>(() => read(activeSandboxId.value));

/** The chats closed with words still in them, newest first; the board draws them like any open tab's draft. */
export const closedDrafts: ComputedRef<readonly StoredTab[]> = computed(() => kept.value);

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

// How long claimed words wait for the composer they went to before this window stops standing in for them (ms). The
// answer is one BroadcastChannel round trip; this only bounds a chat window that shut before it could give one.
const HANDOFF_MS = 5_000;

// Claimed words on their way to a composer, until the window drawing the chat says it holds them. The claim is this
// window's and immediate; the composer may be another window's (a popped-out chat), whose strip reaches here a
// round trip later. Without this the board drew the card from neither for the frames between, and a click on a closed
// draft's card took the card off the board and put it back (useChat-strip.draftsInTransit decides when they arrived).
const inTransit = sandboxShallowRef<readonly StoredTab[]>(() => []);

/** Words claimed out of the set and not yet confirmed in a composer, newest first. */
export const handedOff: ComputedRef<readonly StoredTab[]> = computed(() => inTransit.value);

/** Stops standing in for these: their composer holds them now, or they are gone for good. */
export const settleHandoffs = (settled: (entry: StoredTab) => boolean): void => {
    if (inTransit.value.some(settled)) {
        inTransit.value = inTransit.value.filter((entry) => !settled(entry));
    }
};

// Returns and drops the named entries: the words are about to live in a composer again, so no duplicate can
// go stale. Claimed once per reveal, so a multi-tab reveal writes and broadcasts the remainder once.
export const claimClosedDrafts = (conversationIds: readonly string[]): readonly StoredTab[] => {
    const wanted = new Set(conversationIds);
    const found = kept.value.filter((entry) => wanted.has(entry.conversationId));
    if (found.length > 0) {
        inTransit.value = [...found, ...inTransit.value.filter((entry) => !wanted.has(entry.conversationId))];
        publish(kept.value.filter((entry) => !wanted.has(entry.conversationId)));
        // By identity, so a later claim of the same chat keeps its own full wait.
        setTimeout(() => settleHandoffs((entry) => found.includes(entry)), HANDOFF_MS);
    }
    return found;
};

/** Drops an entry without reopening it, for the board's × that closes the conversation for good. */
export const forgetClosedDraft = (conversationId: string): void => {
    settleHandoffs((entry) => entry.conversationId === conversationId);
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
