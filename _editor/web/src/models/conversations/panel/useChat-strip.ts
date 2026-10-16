import { computed, type ComputedRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { drawsChat, elsewherePreviews, elsewhereStrip, publishPreviews, publishStrip } from "../run/chatEcho";
import { chatRun } from "../run/chatRun";
import { closedDrafts, handedOff, settleHandoffs } from "../drafts/closedDrafts";
import { type DraftPreviews, draftPreview } from "../drafts/draftPreview";
import { type Strip, tabFacts } from "../tabs/tabFacts";
import type { StoredTab } from "../tabs/tabSnapshot";
import { activeId, conversations, panes, scopedSandboxId } from "../tabs/useChat-tabs";

// Outside surfaces must read the owner's complete projection, never combine it with this window's shadow tabs.
//
// Two projections, split by how fast they move. The strip is a tab's facts — opened, sent, named, closed — and is
// what `useAgents-fleet.fleet` (and so `agentById`, and so every surface that asks the roster anything) rebuilds
// from. The previews are the words in the composers, which move per character. Keeping them apart is what stops a
// keystroke from rebuilding the roster: neither the strip computed nor the watcher that publishes it moves while
// someone types.
const localStrip = computed<Strip>(() => ({
    active: activeId.value,
    panes: panes.value,
    tabs: conversations.value.map(tabFacts),
    run: chatRun.value,
}));

// An empty composer leaves no entry rather than an empty one, so "nothing waiting" reads the same — `undefined` —
// whether the conversation is open, closed or unheard of.
const previewsOf = <T>(items: readonly T[], id: (item: T) => string, draft: (item: T) => string): DraftPreviews =>
    Object.fromEntries(
        items.flatMap((item) => {
            const line = draftPreview(draft(item));
            return line === undefined ? [] : [[id(item), line] as const];
        }),
    );

const localPreviews = computed<DraftPreviews>(() =>
    previewsOf(
        conversations.value,
        (conversation) => conversation.conversationId,
        (conversation) => conversation.draft.value,
    ),
);

export const chatStrip: ComputedRef<Strip> = computed(() => (drawsChat.value ? localStrip.value : elsewhereStrip.value));

const livePreviews = computed<DraftPreviews>(() => (drawsChat.value ? localPreviews.value : elsewherePreviews.value));

/**
 * Closed-chat words this window claimed that the chat's own window has not yet shown back: no tab for them in the
 * strip, or a tab saying it has words whose preview has not landed (the two travel as separate notes). The board
 * draws these as it drew the closed draft, so a card does not drop out for the round trip to a popped-out chat.
 */
export const draftsInTransit: ComputedRef<readonly StoredTab[]> = computed(() => {
    const tabs = new Map(chatStrip.value.tabs.map((tab) => [tab.id, tab] as const));
    const live = livePreviews.value;
    return handedOff.value.filter((entry) => {
        const open = tabs.get(entry.conversationId);
        return open === undefined || (open.unsent && live[entry.conversationId] === undefined);
    });
});

// Arrived ones stop being stood in for at once: a stand-in outliving its arrival would put a closed card back on the
// board the moment the chat closes again with nothing in it.
watch(draftsInTransit, (pending) => settleHandoffs((entry) => !pending.includes(entry)));

// Words set aside by a closed chat are already in every window (closedDrafts has its own note), so they need no
// publishing — only merging, under the live composers, which win the id they share. Words in transit go under the set,
// which holds the newer copy when a chat was closed again before its last trip came back.
export const chatPreviews: ComputedRef<DraftPreviews> = computed(() => ({
    ...previewsOf(
        [...draftsInTransit.value, ...closedDrafts.value],
        (tab) => tab.conversationId,
        (tab) => tab.draft,
    ),
    ...livePreviews.value,
}));

/**
 * The words standing in one conversation's composer, wherever in this browser it is drawn.
 *
 * Reads the whole map, so a component calling this from its render tracks every composer. Wrap it in a computed of
 * its own (AgentCard) and Vue compares the resulting string: only the card whose words changed redraws.
 */
export const previewOf = (conversationId: string): string | undefined => chatPreviews.value[conversationId];

// Serialized as the change key, and as a computed rather than inside the watcher, because those are two different
// gates. A keystroke wakes both watchers whatever happens: `unsent` is derived from the draft, so Vue marks the chain
// dirty and runs the jobs before finding the values settled. A computed compares the STRING it produced, so an
// unchanged strip stops here — where a watcher whose getter returns a fresh array could not tell, and republished
// identical tabs on every character, waking every other window's card list through `elsewhereStrip`.
//
// Scope rides inside the key even when two sandboxes happen to restore identical tab data, and the parse back is what
// detaches the published snapshot from this window's reactive objects.
const publishableStrip = computed(() => (drawsChat.value ? JSON.stringify({ sandbox: scopedSandboxId.value, strip: localStrip.value }) : undefined));

watch(
    publishableStrip,
    (json) => {
        if (json !== undefined) {
            const { sandbox, strip } = JSON.parse(json) as { sandbox?: string; strip: Strip };
            publishStrip(strip, sandbox);
        }
    },
    { immediate: true },
);

const publishablePreviews = computed(() =>
    drawsChat.value ? JSON.stringify({ sandbox: scopedSandboxId.value, previews: localPreviews.value }) : undefined,
);

watch(
    publishablePreviews,
    (json) => {
        if (json !== undefined) {
            const { sandbox, previews } = JSON.parse(json) as { sandbox?: string; previews: DraftPreviews };
            publishPreviews(previews, sandbox);
        }
    },
    { immediate: true },
);

// Singleton per window: a hot-reloaded rerun would publish a second, competing strip.
reloadOnHotUpdate(import.meta);
