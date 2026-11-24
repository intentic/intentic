<!-- What this chat itself offers the reader to press, as lines of the dock over its composer: a request to read it, its way back from the archive, its land, its commit and push. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { computerAgents } from "../../../../client/sandbox/useDaemonRoutes";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useTier } from "../../../../client/sandbox/useTier";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { useAgents } from "../../../../models/fleet/useAgents";
import ChatDockRow from "./ChatDockRow.vue";
import ChatLandStrip from "../landing/ChatLandStrip.vue";
import ChatShipStrip from "../landing/ChatShipStrip.vue";
import { landStripOf } from "../landing/landStrip";
import { shipsFrom } from "../landing/shipStrip";
import SealAsks from "../seal/SealAsks.vue";

// The states the conversation arrived at by itself, each with its one answering press: somebody asking to read it,
// archived, work waiting to land, landed work to commit and push. They were strips of their own among the account and
// trial notices (ChatPaneNotices), which say whether the chat can send at all; these say what to do with what it did,
// so they stand in the dock with the asks (ChatDock). A chat on this computer has none of them. Reads this pane's
// conversation via the injected view, never the focused one.

const t = useT();

const { conversation, streaming } = usePaneView();
const { reachable } = useSandbox();
const { agentById, archived, loadArchived, restore, busyIds } = useAgents();

// An archived agent can still be read in an open tab (opened from the archive view, or swept there while open);
// says so and offers the one way back, plus that sending un-archives it. Loaded on the reachable seam, not at
// setup, since the pane mounts before the daemon answers; only while the list is empty.
watch(
    reachable,
    (live) => {
        if (live && archived.value.length === 0) {
            void loadArchived();
        }
    },
    { immediate: true },
);
const activeArchived = computed(() => {
    const agent = agentById(conversation.value.conversationId);
    return agent?.archivedAt === undefined ? undefined : agent;
});

// Its finished work still on its branch, its land under way, or its land refused, with the press the board card offers
// for it (landStrip.ts): said here for the reader who opened the chat rather than landed it from the board.
const { canShip, canReview } = useTier();
const landStrip = computed(() => {
    const agent = agentById(conversation.value.conversationId);
    const strip = landStripOf(agent, {
        canAct: canShip.value || canReview.value,
        streaming: streaming.value,
        elsewhere: conversation.value.box.value !== undefined,
    });
    return agent === undefined || strip === undefined ? undefined : { agent, strip };
});

// Once that work is in the tree, the two presses that take it the rest of the way, commit then push (shipStrip.ts):
// for a maintainer reading in a developer's words, since a maker's save is never one chat's files alone.
const { maker } = useAudience();
const shipAgent = computed(() => {
    const agent = agentById(conversation.value.conversationId);
    const reader = { canShip: canShip.value, maker: maker.value, streaming: streaming.value, elsewhere: conversation.value.box.value !== undefined };
    return shipsFrom(agent, reader) ? agent : undefined;
});
</script>

<template>
    <template v-if="!computerAgents">
        <!-- Who asked to read this private conversation, answered by its reader here (SealAsks). -->
        <SealAsks />
        <!-- This conversation's agent is off the board. -->
        <ChatDockRow v-if="activeArchived !== undefined" icon="box" :title="t(`chat.chatPaneNotices.archived`)" role="status">
            <template #detail>{{ t(`chat.chatPaneNotices.archivedDetail`) }}</template>
            <template #actions>
                <Button size="small" thumb tier="boring" :disabled="!reachable || busyIds.includes(activeArchived.id)" @click="restore([activeArchived.id])">
                    {{ t(`ui.action.restore`) }}
                </Button>
            </template>
        </ChatDockRow>
        <ChatLandStrip v-else-if="landStrip !== undefined" :agent="landStrip.agent" :strip="landStrip.strip" />
        <ChatShipStrip v-else-if="shipAgent !== undefined" :agent="shipAgent" />
    </template>
</template>
