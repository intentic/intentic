<!-- WHETHER THE CONVERSATIONS YOU START HERE BEGIN PRIVATE, where this sandbox's house rule leaves it to each author
     (schemas/seal.ts `chooses`). The reader's own answer, saved as it is pressed; each new conversation's composer still
     offers the other way before its first message. Not drawn where the house rule decides for everyone. -->
<script setup lang="ts">
import { Row, RowGroup, RowNote } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useSealHouse } from "../../models/conversations/seal/useSealHouse";

const t = useT();

const { house, setOwnDefault } = useSealHouse();
const { active } = useSandbox();

const on = computed(() => house.value?.ownDefault ?? house.value?.startsPrivate ?? false);
const saving = ref(false);
const failure = ref<string>();
const toggle = async (next: boolean): Promise<void> => {
    saving.value = true;
    failure.value = undefined;
    try {
        await setOwnDefault(next);
    } catch (error) {
        failure.value = messageOr(error, t(`settings.conversations.saveFailed`));
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <RowGroup v-if="house?.mode === `chooses`" data-setting="start-private" :label="t(`settings.conversations.title`)">
        <Row
            :title="t(`settings.conversations.startPrivate`)"
            :description="t(`settings.conversations.startPrivateHint`, { sandbox: active?.name ?? `` })"
        >
            <template #control><ToggleSwitch :model-value="on" :disabled="saving" @update:model-value="toggle" /></template>
        </Row>
        <RowNote v-if="failure !== undefined"><span role="alert" class="text-danger">{{ failure }}</span></RowNote>
    </RowGroup>
</template>
