<script setup lang="ts">
import type { MatchSnippet } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount } from "vue";
import { cacheWarm } from "../../agents/fleet/promptCache";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { createCardViews, type OpenChat } from "./cardView";
import ChatTabRow from "./ChatTabRow.vue";
import { laneOfTab } from "./tabs";
import { injectChatRowActions } from "./useChatRowActions";

// A run of open chats drawn as rail rows, the same rows whichever cut (lanes or personas) holds them: every gesture and
// menu comes from the host's one set of verbs (useChatRowActions), so no cut can offer less than another.

const t = useT();

const props = defineProps<{
    entries: readonly OpenChat[];
    needle?: string;
    matchCase?: boolean;
    // Why a filtered row matched, for the lanes' filter; absent where nothing filters.
    snippetOf?: (agent: FleetAgent) => MatchSnippet | undefined;
}>();

const actions = injectChatRowActions();
const { edit } = actions;

// The cooling chip is the only readout these rows draw off a clock, so the tick is armed by the same gate the chip is.
const cooling = computed(() => props.entries.some(({ agent }) => agent !== undefined && cacheWarm(agent)));
const now = useNow(() => cooling.value);

// One view-model cache per list, pruned to what it draws, so a pass over unchanged facts redraws no row.
const views = createCardViews();
const rows = computed(() => {
    const alive = new Set<string>();
    const built = props.entries.map((entry) => {
        alive.add(entry.conversation.conversationId);
        const snippet = entry.agent === undefined ? undefined : props.snippetOf?.(entry.agent);
        return { ...entry, view: views.of(entry, snippet, now.value) };
    });
    views.prune(alive);
    return built;
});

const drawnIds = computed<ReadonlySet<string>>(() => new Set(props.entries.map((entry) => entry.conversation.conversationId)));
onBeforeUnmount(actions.registerDrawn(() => drawnIds.value));
</script>

<template>
    <div class="flex min-w-0 flex-col gap-2.5">
        <template v-for="{ conversation: c, agent, view } in rows" :key="c.conversationId">
            <!-- Replaces the card rather than nesting a field in it (a button can't host a usable input). -->
            <input
                v-if="edit.editing && actions.renamingId.value === c.conversationId"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                :aria-label="t(`shared.chatTitle`)"
                :placeholder="c.isolated.value ? t(`shared.newAgent`) : t(`shared.newChat`)"
                class="ui-field-box ui-field-inline w-full shrink-0 select-text rounded-lg px-2.5 py-2 text-xs font-semibold placeholder:font-normal"
                @keydown.enter.stop.prevent="edit.commit()"
                @keydown.esc.stop.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <!-- Its own component so the composer's draft, which names an unnamed card, is read inside the row. -->
            <ChatTabRow
                v-else
                :conversation="c"
                :agent="agent"
                :view="view"
                :needle="props.needle"
                :match-case="props.matchCase"
                :selected="actions.isSelected(c.conversationId)"
                :attention="laneOfTab(c, agent) === 'attention'"
                :closable="actions.closable.value"
                @select="actions.click($event, c.conversationId)"
                @rename="actions.beginRename(c.conversationId)"
                @menu="actions.openMenu(c.conversationId, $event)"
                @hover="actions.showPreview($event, { conversation: c, agent })"
                @leave="actions.hidePreview()"
                @close="actions.close(c.conversationId)"
                @keep="actions.keep(c.conversationId)"
                @middle-close="actions.middleClose(c.conversationId)"
            />
        </template>
    </div>
</template>
