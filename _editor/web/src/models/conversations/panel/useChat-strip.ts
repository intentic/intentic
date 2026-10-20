import { computed, type ComputedRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { drawsChat, elsewhereStrip, publishStrip } from "../run/chatEcho";
import { chatRun } from "../run/chatRun";
import { draftPreviews } from "../drafts/composerDrafts";
import type { DraftPreviews } from "../drafts/draftPreview";
import { type Strip, tabFacts } from "../tabs/tabFacts";
import { activeId, conversations, panes, scopedSandboxId } from "../tabs/useChat-tabs";

// Outside surfaces must read the owner's complete projection, never combine it with this window's shadow tabs.
//
// The strip is a tab's facts — opened, sent, named, closed — and is what `useAgents-fleet.fleet` (and so `agentById`,
// and so every surface that asks the roster anything) rebuilds from. The words in the composers move per character and
// are no part of it: they are the conversations' drafts (composerDrafts.ts), which every window of this browser already
// holds, so a keystroke rebuilds no roster and travels on no strip.
const localStrip = computed<Strip>(() => ({
    active: activeId.value,
    panes: panes.value,
    tabs: conversations.value.map(tabFacts),
    run: chatRun.value,
}));

export const chatStrip: ComputedRef<Strip> = computed(() => (drawsChat.value ? localStrip.value : elsewhereStrip.value));

/** The opening words of every unsent message in this browser, open chat or closed, by conversation. */
export const chatPreviews: ComputedRef<DraftPreviews> = draftPreviews;

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

// Singleton per window: a hot-reloaded rerun would publish a second, competing strip.
reloadOnHotUpdate(import.meta);
