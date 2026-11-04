<!-- THE HEAD OF A CONVERSATION THAT IS, OR MAY BE MADE, PRIVATE: who reads it, as the value its reader changes it from
     (SealPill), and under it every opening without asking, for good (SealOpenings). Drawn at the top of the transcript so
     it reads first and is the same in a docked panel, a wide column and a phone, none of which has a header of the
     pane's own. A conversation nobody sealed, in a house where none can be, draws nothing at all. -->
<script setup lang="ts">
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useAuth } from "../../../../client/auth/useAuth";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { setPrivate } from "../../../../models/fleet/presses/sealPresses";
import { addedReaders, openingsOf, pillOffered, readsAsReader, sealLabel } from "../../../../models/agent-status/sealView";
import { useSealHouse } from "../../../../models/conversations/seal/useSealHouse";
import { parentOf } from "../../../../models/agent-status/ownership";
import { useAgents } from "../../../../models/fleet/useAgents";
import SealOpenings from "./SealOpenings.vue";
import SealPill from "./SealPill.vue";

const t = useT();

const { conversation } = usePaneView();
const { agentById } = useAgents();
const { user } = useAuth();
const { house } = useSealHouse();

const card = computed(() => agentById(conversation.value.conversationId));
const seal = computed(() => card.value?.seal);
const me = computed(() => user.value?.email ?? undefined);

// Who may change it: a reader of a private one; of a shared one, whoever answers for it, or anyone who sees it while
// nobody does (seal.contract.ts `set`). Never a subagent's or a review's own: those follow the conversation they came from.
const authorOfShared = computed(() => {
    const whose = card.value?.owner?.email;
    if (card.value === undefined || card.value.home === true || parentOf(card.value.startedBy) !== undefined) {
        return false;
    }
    return whose === undefined || (me.value !== undefined && whose.toLowerCase() === me.value.toLowerCase());
});
const pill = computed(() => {
    if (card.value === undefined || conversation.value.registered.value !== true || !pillOffered(house.value, seal.value)) {
        return false;
    }
    return seal.value === undefined ? authorOfShared.value : readsAsReader(card.value);
});
const opens = computed(() => openingsOf(seal.value));

const busy = ref(false);
const failure = ref<string>();
const change = async (next: { readonly private: boolean; readonly readers: readonly string[] }): Promise<void> => {
    busy.value = true;
    failure.value = undefined;
    try {
        await setPrivate(conversation.value.conversationId, next.private, next.private ? next.readers : undefined);
    } catch (error) {
        failure.value = messageOr(error, t(`chat.seal.saveFailed`));
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div v-if="pill || opens.length > 0" class="mx-auto flex w-full max-w-[51rem] flex-col gap-2 px-2 pb-3" data-seal-head>
        <div v-if="pill" class="flex min-w-0 items-center">
            <SealPill
                :label="sealLabel(seal, me)"
                :private="seal !== undefined"
                :readers="addedReaders(seal)"
                :busy="busy"
                :error="failure"
                @change="change"
            />
        </div>
        <SealOpenings v-if="opens.length > 0" :conversation-id="conversation.conversationId" :opens="opens" :can-approve="seal?.canApprove === true" />
    </div>
</template>
