<script setup lang="ts">
import type { MatchSnippet } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount } from "vue";
import { cacheWarm } from "../../agents/fleet/prompt-cache/promptCache";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import ChildRows from "../../agents/board/cards/ChildRows.vue";
import { subagentOnScreen } from "../panel/subagent/subagentView";
import { createCardViews, type OpenChat } from "./cardView";
import ChatTabRow from "./ChatTabRow.vue";
import { laneOfTab } from "./tabs";
import { injectChatRowActions } from "./useChatRowActions";

// A run of open chats drawn as rail rows, the same rows whichever cut (lanes or personas) holds them: every gesture and
// menu comes from the host's one set of verbs (useChatRowActions), so no cut can offer less than another.

const t = useT();

const props = withDefaults(
    defineProps<{
        entries: readonly OpenChat[];
        needle?: string;
        matchCase?: boolean;
        // Why a filtered row matched, for the lanes' filter; absent where nothing filters.
        snippetOf?: (agent: FleetAgent) => MatchSnippet | undefined;
        // False where the reader is looking at who a chat speaks as rather than what it set going (the Personas cut):
        // each card is drawn alone, without the tray of agents it started, which the Agents cut and the board still hang
        // under it. Defaulted here, not read as `!== false`: Vue hands an absent boolean prop over as `false`.
        trays?: boolean;
    }>(),
    { trays: true },
);

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

// A card's ring means its own chat is on screen: while its column shows a subagent, the ring is on that subagent's row.
const selected = (id: string): boolean => actions.isSelected(id) && subagentOnScreen.value?.parentId !== id;

const drawnIds = computed<ReadonlySet<string>>(() => new Set(props.entries.map((entry) => entry.conversation.conversationId)));
onBeforeUnmount(actions.registerDrawn(() => drawnIds.value));
</script>

<template>
    <div class="flex min-w-0 flex-col gap-3.5">
        <!-- Each card with the tray of agents it started hung from it (ChildRows), read the way the board's cards read, and sliding as one when a tray above opens or shuts (ChatTabList's useFoldFlip). -->
        <div v-for="{ conversation: c, agent, view } in rows" :key="c.conversationId" class="flex min-w-0 flex-col" data-fold-unit data-reveal>
            <!-- Replaces the card rather than nesting a field in it (a button can't host a usable input). -->
            <input
                v-if="edit.editing && actions.renamingId.value === c.conversationId"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                :aria-label="t(`chat.words.chatTitle`)"
                :placeholder="c.isolated.value ? t(`chat.words.newAgent`) : t(`chat.words.newChat`)"
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
                :selected="selected(c.conversationId)"
                :attention="laneOfTab(c, agent) === 'attention'"
                :closable="actions.closable.value"
                @select="actions.click($event, c.conversationId)"
                @menu="actions.openMenu(c.conversationId, $event)"
                @hover="actions.showPreview($event, { conversation: c, agent })"
                @leave="actions.hidePreview()"
                @close="actions.close(c.conversationId)"
                @keep="actions.keep(c.conversationId)"
                @middle-close="actions.middleClose(c.conversationId)"
            />
            <ChildRows v-if="agent !== undefined && props.trays" :agent="agent" :focused="selected(c.conversationId)" rail />
        </div>
    </div>
</template>
