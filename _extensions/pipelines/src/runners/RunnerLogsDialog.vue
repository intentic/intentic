<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Code, Modal } from "@intentic/extension-ui";
import { ref, watch } from "vue";
import { t } from "../i18n.js";

// The tail of one runner's service log, read once each time the dialog opens: a log is read when asked for, not
// polled, since the route reaches the computer every time.

const props = defineProps<{ name: string; read: () => Promise<string> }>();
const open = defineModel<boolean>("open", { required: true });

const text = ref<string | undefined>();
const failure = ref<string | undefined>();

watch(
    open,
    async (now) => {
        if (!now) {
            return;
        }
        text.value = undefined;
        failure.value = undefined;
        try {
            text.value = await props.read();
        } catch (error) {
            failure.value = errorMessage(error);
        }
    },
    { immediate: true },
);
</script>

<template>
    <Modal v-model:open="open" size="lg" :header="t(`runners.logs.title`, { name })">
        <p v-if="failure" class="text-sm break-words text-danger">{{ failure }}</p>
        <p v-else-if="text === undefined" class="text-sm text-muted">{{ t(`runners.logs.loading`) }}</p>
        <p v-else-if="text.trim() === ``" class="text-sm text-muted">{{ t(`runners.logs.empty`) }}</p>
        <Code v-else :code="text" :scroll-lines="30" scroll-bottom tail copyable />
    </Modal>
</template>
