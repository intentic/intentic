<!-- WHETHER A NEW CONVERSATION STARTS PRIVATE, in the composer's row before its first message: the house rule's start for
     this reader (GET /seal `startsPrivate`), until they press it otherwise. The message that opens the conversation
     carries the answer (`agent.run` `private`); from then on it is the conversation's own, changed at its head
     (ChatSealHead). Not drawn where nothing new can be private, nor once the conversation is on record. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import { useSealHouse } from "../../../../models/conversations/seal/useSealHouse";
import SealPill from "./SealPill.vue";

const t = useT();

const { conversation } = defineProps<{ conversation: Conversation }>();

const { house } = useSealHouse();
const shown = computed(() => house.value !== undefined && house.value.mode !== `everyone` && !conversation.registered.value);
const closed = computed(() => conversation.privateDraft.value ?? house.value?.startsPrivate ?? false);
const label = computed(() => (closed.value ? t(`chat.seal.private`) : t(`chat.seal.shared`)));
</script>

<template>
    <SealPill
        v-if="shown"
        composer
        :label="label"
        :private="closed"
        :people="false"
        @change="(next) => (conversation.privateDraft.value = next.private)"
    />
</template>
