<!-- What a draft's passing fire sets off, in a line ("Starts a new agent", "Continues Weekly review", "Notifies you"); pressed, the panel where that is chosen. -->
<script setup lang="ts">
import { Picker, type PickerOption } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { since } from "../cronSchedule";
import ChoiceList from "../properties/ChoiceList.vue";
import PropertyPopover from "../properties/PropertyPopover.vue";
import PropertyRow from "../properties/PropertyRow.vue";
import { EDITABLE_VALUE } from "../properties/propertyLook";
import { useConversations } from "../useAutomations";
import type { AutomationFormState } from "../useAutomationForm";
import { t } from "../i18n.js";

const props = defineProps<{ state: AutomationFormState }>();
const { form, conversationError, touched, markTouched } = props.state;

const CHOICES = computed(() => [
    { value: `agent` as const, title: t(`thenProperty.agent`), note: t(`automationFields.targetCaption.agent`) },
    { value: `conversation` as const, title: t(`thenProperty.conversation`), note: t(`automationFields.targetCaption.conversation`) },
    { value: `notify` as const, title: t(`automationRow.notifiesYou`), note: t(`automationFields.targetCaption.notify`) },
]);

// The board's conversations by title, newest first; read only while that target is picked.
const { conversations, titleOf } = useConversations(computed(() => form.target === `conversation`));
const conversationOptions = computed<readonly PickerOption[]>(() =>
    conversations.value.map((conversation) => ({ value: conversation.id, label: conversation.title ?? conversation.id, description: since(conversation.updatedAt) })),
);

const said = computed(() => {
    if (form.target === `conversation`) {
        return form.conversationId === `` ? t(`thenProperty.pickConversation`) : t(`automationRow.continues`, { conversation: titleOf(form.conversationId) });
    }
    return CHOICES.value.find((choice) => choice.value === form.target)?.title ?? ``;
});
const shownError = computed(() => (touched.has(`conversation`) ? conversationError.value : undefined));

const anchor = ref<HTMLElement>();
const open = ref(false);
let before = { target: form.target, conversationId: form.conversationId };
const begin = (): void => {
    before = { target: form.target, conversationId: form.conversationId };
    open.value = true;
};
const cancel = (): void => {
    Object.assign(form, before);
};
const done = (): void => {
    markTouched(`conversation`);
    open.value = false;
};
</script>

<template>
    <PropertyRow :label="t(`automationRow.then`)">
        <button ref="anchor" type="button" :class="EDITABLE_VALUE" :aria-label="t(`thenProperty.change`, { now: said })" @click="begin">
            <span class="text-sm text-content">{{ said }}</span>
            <span v-if="shownError" class="text-xs text-danger">{{ shownError }}</span>
        </button>

        <PropertyPopover v-model="open" :anchor="anchor" :header="t(`automationRow.then`)" :can-save="form.target !== `conversation` || form.conversationId !== ``" @save="done" @cancel="cancel">
            <ChoiceList v-model="form.target" :choices="CHOICES" :label="t(`automationRow.then`)" />
            <Picker
                v-if="form.target === `conversation`"
                v-model="form.conversationId"
                :options="conversationOptions"
                :placeholder="t(`automationFields.pickConversation`)"
                :aria-label="t(`automationFields.conversationToContinue`)"
                class="ml-9 w-auto"
            />
        </PropertyPopover>
    </PropertyRow>
</template>
