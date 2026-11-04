<!-- WHO HAS ASKED TO READ THIS PRIVATE CONVERSATION, above its composer where its reader answers: a strip each, with the
     three answers the author can give (schemas/seal.ts SealAnswerSchema). Show for a day lets them read it, read-only, for
     a day; Add makes them a reader for good; Decline says no, and they can ask again. Only for one of its readers. -->
<script setup lang="ts">
import type { SealAnswer, SealAsk } from "@intentic/sandbox-contract/schemas/seal";
import { Avatar, Button, timeAgo, useDevice } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { identityHue } from "../../../../lib/identityHue";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { answerAsk } from "../../../../models/fleet/presses/sealPresses";
import { firstName, fullName, readsAsReader } from "../../../../models/agent-status/sealView";
import { useAgents } from "../../../../models/fleet/useAgents";

const t = useT();

const { conversation } = usePaneView();
const { agentById } = useAgents();
const { mobile } = useDevice();

const card = computed(() => agentById(conversation.value.conversationId));
const asks = computed((): readonly SealAsk[] => (readsAsReader(card.value) ? (card.value?.seal?.asks ?? []) : []));

const busy = ref<string>();
const failure = ref<string>();
const answer = async (ask: SealAsk, reply: SealAnswer[`answer`]): Promise<void> => {
    busy.value = ask.email;
    failure.value = undefined;
    try {
        await answerAsk(conversation.value.conversationId, ask.email, reply);
    } catch (error) {
        failure.value = messageOr(error, t(`chat.seal.asks.failed`));
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <div
        v-for="ask in asks"
        :key="ask.email"
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-card px-3 py-2 text-2xs shadow-sm"
        role="status"
        data-seal-ask
    >
        <!-- At least a line's width for who asks, so a narrow chat puts the answers under it rather than squeezing the name. -->
        <span class="flex min-w-0 flex-1 basis-56 items-center gap-2">
            <Avatar :size="20" :name="fullName(ask)" :hue="identityHue(ask.email)" class="shrink-0" />
            <span class="min-w-0 font-medium text-content">{{ t(`chat.seal.asks.asks`, { name: fullName(ask) }) }}</span>
            <span class="shrink-0 text-subtle">{{ timeAgo(ask.at) }}</span>
        </span>
        <span :class="mobile ? `grid w-full grid-cols-3 gap-2` : `flex shrink-0 items-center gap-1.5`">
            <Button :size="mobile ? undefined : `small`" :thumb="mobile" tier="boring" :disabled="busy !== undefined" :loading="busy === ask.email" @click="answer(ask, `day`)">{{
                t(`chat.seal.asks.day`)
            }}</Button>
            <Button :size="mobile ? undefined : `small`" :thumb="mobile" tier="boring" :disabled="busy !== undefined" @click="answer(ask, `always`)">{{
                t(`chat.seal.asks.add`, { name: firstName(ask) })
            }}</Button>
            <Button :size="mobile ? undefined : `small`" :thumb="mobile" tier="quiet" :disabled="busy !== undefined" @click="answer(ask, `decline`)">{{
                t(`chat.seal.asks.decline`)
            }}</Button>
        </span>
    </div>
    <p v-if="failure !== undefined" role="alert" class="px-1 text-2xs text-danger">{{ failure }}</p>
</template>
