<!-- WHO HAS ASKED TO READ THIS PRIVATE CONVERSATION, in the dock over its composer where its reader answers: a line each, with the
     three answers the author can give (schemas/seal.ts SealAnswerSchema). Show for a day lets them read it, read-only, for
     a day; Add makes them a reader for good; Decline says no, and they can ask again. Only for one of its readers. -->
<script setup lang="ts">
import type { SealAnswer, SealAsk } from "@intentic/sandbox-contract/schemas/seal";
import { Avatar, Button, timeAgo } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { identityHue } from "../../../../lib/identityHue";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { answerAsk } from "../../../../models/fleet/presses/sealPresses";
import { firstName, fullName, readsAsReader } from "../../../../models/agent-status/sealView";
import { useAgents } from "../../../../models/fleet/useAgents";
import ChatDockRow from "../dock/ChatDockRow.vue";

const t = useT();

const { conversation } = usePaneView();
const { agentById } = useAgents();

const card = computed(() => agentById(conversation.value.conversationId));
const asks = computed((): readonly SealAsk[] => (readsAsReader(card.value) ? (card.value?.seal?.asks ?? []) : []));

const busy = ref<string>();
// Why the last answer did not go, said on the line it was given on.
const failure = ref<{ readonly email: string; readonly message: string }>();
const answer = async (ask: SealAsk, reply: SealAnswer[`answer`]): Promise<void> => {
    busy.value = ask.email;
    failure.value = undefined;
    try {
        await answerAsk(conversation.value.conversationId, ask.email, reply);
    } catch (error) {
        failure.value = { email: ask.email, message: messageOr(error, t(`chat.seal.asks.failed`)) };
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <!-- A line of the dock each, the face in the glyph's place: who asks is the whole of it. Decline first and quiet, the two
         ways to let them read after it. -->
    <ChatDockRow v-for="ask in asks" :key="ask.email" :title="t(`chat.seal.asks.asks`, { name: fullName(ask) })" role="status" data-seal-ask>
        <template #mark><Avatar :size="16" :name="fullName(ask)" :hue="identityHue(ask.email)" /></template>
        <template #meta>{{ timeAgo(ask.at) }}</template>
        <template v-if="failure?.email === ask.email && busy === undefined" #detail>
            <span role="alert" class="text-danger">{{ failure.message }}</span>
        </template>
        <template #actions>
            <Button size="small" thumb tier="quiet" :disabled="busy !== undefined" @click="answer(ask, `decline`)">{{ t(`chat.seal.asks.decline`) }}</Button>
            <Button size="small" thumb tier="boring" :disabled="busy !== undefined" @click="answer(ask, `always`)">{{
                t(`chat.seal.asks.add`, { name: firstName(ask) })
            }}</Button>
            <Button size="small" thumb tier="boring" :disabled="busy !== undefined" :loading="busy === ask.email" @click="answer(ask, `day`)">{{
                t(`chat.seal.asks.day`)
            }}</Button>
        </template>
    </ChatDockRow>
</template>
