<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatCard from "../../../../components/ChatCard.vue";
import ChatDecisionButton from "../../../../components/ChatDecisionButton.vue";
import { here, page } from "../../../../lib/routes/links";
import { helpStatus } from "./cardStatus";
import { useChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import { runnerOf } from "../../../../models/placement/runnerPlacement";
import { conversationWindow } from "../../../../models/browsers/runnerWindows";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.browserHelp!);

// The window it waits in: for a conversation that runs on a runner, that runner's, as this sandbox lists it.
const surface = useChatSurface();
// The shared browsers list (the Browsers view reads the same entry), read here without the view's module.
const { query: browsers } = useSandboxQuery(rpcQuery(`system.browsers`));
const waitsIn = computed(() => {
    const conversationId = surface.resultConversation?.();
    const runner = runnerOf(conversationId);
    return runner === undefined || conversationId === undefined
        ? card.value.session
        : conversationWindow(browsers.data.value?.sessions ?? [], { runner, conversationId, own: card.value.session });
});
</script>

<template>
    <!-- The agent's browser needs a person; the primary action navigates to Browsers, where the live stage and hand-back live. -->
    <ChatCard
        icon="desktop"
        icon-class="text-warning"
        :title="t(`chat.chatMessageView.agentsBrowserNeeds`, { account: card.account })"
        :status="helpStatus(card)"
    >
        <div class="chat-card-body text-xs text-content/85">{{ card.message }}</div>

        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton tone="primary" icon="desktop" :to="here(page.browsers(waitsIn))">{{
                t(`chat.chatMessageView.openBrowser`)
            }}</ChatDecisionButton>
            <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="reply({ kind: 'browser_help', helped: false })">{{
                t(`chat.words.cantHelpNow`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
