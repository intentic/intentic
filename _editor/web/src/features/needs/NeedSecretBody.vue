<!-- A secret need's own answer: one masked field whose value goes straight to the sandbox's store, never the chat. -->
<script setup lang="ts">
import type { Need, SecretNeed } from "@intentic/sandbox-contract";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import SecretField from "../capabilities/connect/secrets/SecretField.vue";
import ChatDecisionButton from "../chat/transcript/cards/ChatDecisionButton.vue";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: SecretNeed }>();

const needs = useNeeds();
// Held only until the press; cleared whether or not it was taken.
const value = ref(``);
// The need's answer, wherever it is drawn (needAnswer.ts).
const { busy, notice, answer } = useNeedAnswer(() => props.need);

const save = async (): Promise<void> => {
    const given = value.value.trim();
    if (given === `` || busy.value) {
        return;
    }
    // Out of the field at the press: the value goes to the store and nowhere else, taken or not.
    value.value = ``;
    const id = props.need.id;
    await answer({ tag: `save`, failed: t(`needs.secret.couldNotSave`), task: () => needs.provideSecret.mutateAsync({ id, value: given }) });
};

// Stored some other way (the Secrets view, a deploy): the daemon checks the name resolves before it takes the word.
const storedElsewhere = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ tag: `elsewhere`, failed: t(`needs.secret.notStoredYet`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `apply` } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <span v-if="subject.replace" class="text-xs text-content/85">{{ t(`needs.secret.replace`, { name: subject.name }) }}</span>
        <span v-if="subject.where" class="text-xs text-content/85">{{ t(`needs.secret.where`, { where: subject.where }) }}</span>
        <span v-if="subject.hint" class="text-2xs text-subtle">{{ t(`needs.secret.hint`, { hint: subject.hint }) }}</span>
        <a v-if="subject.link" :href="subject.link" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-2xs text-link">
            <Icon name="external-link" />{{ t(`needs.secret.getOne`) }}
        </a>
        <SecretField v-model="value" :secret-key="subject.name" collect no-hint />
        <span class="text-2xs text-subtle">{{ t(`needs.secret.stored`, { name: subject.name }) }}</span>
        <div class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton tone="primary" icon="check" :disabled="busy || value.trim() === ``" @click="save">{{ t(`needs.secret.save`) }}</ChatDecisionButton>
            <ChatDecisionButton tone="secondary" :disabled="busy" @click="storedElsewhere">{{ t(`needs.secret.addedElsewhere`) }}</ChatDecisionButton>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
