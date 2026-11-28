<script setup lang="ts">
import { Button, Notice, type NoticeModel, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { ref, shallowRef } from "vue";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { threadsChanged } from "../../../../models/messages/useMessages";

// TAKE INTO A FOLDER: a received message's files copied into a folder of the workspace, never over a file already there.
// By default a folder named for where they came from, editable. What the Overview's Received card did for a drop, which
// arrives as a message now.

const props = defineProps<{ message: string; contactName: string }>();

const t = useT();
const api = useMessagesApi();

// Folded to one quiet press until asked for: most files are only read, and a folder field under every message is noise.
const open = ref(false);
const folder = ref(`received/${props.contactName.replace(/[^\w.-]+/gu, `-`)}`);
const busy = ref(false);
const outcome = shallowRef<NoticeModel>();

const take = async (): Promise<void> => {
    const dest = folder.value.trim();
    if (busy.value || dest === ``) {
        return;
    }
    busy.value = true;
    outcome.value = undefined;
    try {
        const taken = await api.take(props.message, { dest });
        outcome.value = { tone: `success`, title: t(`sandbox.messages.take.taken`, { folder: taken.dest, files: taken.files.join(`, `) }) };
        void threadsChanged();
    } catch (error) {
        outcome.value = noticeFrom(error, t(`sandbox.messages.take.failed`));
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2">
        <button v-if="!open" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs`, flush: true })" data-take-open @click="open = true">
            <Icon name="folder" />{{ t(`sandbox.messages.take.take`) }}
        </button>
        <form v-else class="flex flex-wrap items-center gap-2" data-take @submit.prevent="take">
            <input
                v-model="folder"
                type="text"
                autocomplete="off"
                :aria-label="t(`sandbox.messages.take.folder`)"
                :class="ui.input({ size: `sm` }, `min-w-48 flex-1 font-mono`)"
            />
            <Button tier="quiet" size="small" :label="t(`ui.action.cancel`)" :disabled="busy" @click="open = false" />
            <Button tier="accent" type="submit" size="small" :label="t(`sandbox.messages.take.take`)" :loading="busy" :disabled="busy || folder.trim() === ``">
                <template #icon><Icon name="folder" /></template>
            </Button>
        </form>
        <Notice v-if="outcome" :of="outcome" />
    </div>
</template>
