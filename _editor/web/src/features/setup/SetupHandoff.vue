<!-- Replaces the Copy button on setup step 3 for phones, which have no shell to run the command in. -->
<script setup lang="ts">
import { Button, ui, Notice, type NoticeModel, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { ref } from "vue";
import { apiClient } from "../../lib/useApi";

// `email` is shown, not sent: the server addresses this to the session's own account and takes no recipient,
// so what the caller passes here is only what the confirmation line reads back.
const { sandboxId, email } = defineProps<{ sandboxId: string; email: string }>();

// Not a milestone the page turns on (that is still the command reaching a machine), so the parent only needs
// to know a send landed: for the funnel, and to stop nagging about a terminal.
const emit = defineEmits<{ sent: [] }>();

const sending = ref(false);
const sent = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

const send = async (): Promise<void> => {
    if (sending.value) {
        return;
    }
    sending.value = true;
    error.value = undefined;
    try {
        await apiClient.sandbox.emailSetupLink({ sandboxId });
        sent.value = true;
        emit(`sent`);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't send that email. Try again.`);
    } finally {
        sending.value = false;
    }
};
</script>

<template>
<!-- NO CARD OF ITS OWN. -->
    <div class="flex flex-col gap-2.5">
<!-- The heading a phone needed all along: which device this step belongs to. -->
        <p v-if="!sent" class="flex items-start gap-2.5 text-xs text-muted">
            <Icon name="desktop" class="mt-0.5 shrink-0 text-link" />
            <span class="min-w-0">Not on your phone: this needs a terminal and Docker.</span>
        </p>

        <template v-if="sent">
<!-- Green on the two words that are the confirmation, and nowhere else. -->
            <p class="flex items-start gap-2.5 text-xs text-muted">
                <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                <span class="min-w-0">
                    <span class="font-medium text-success"
                        >Sent to <span class="break-words">{{ email }}</span
                        >.</span
                    >
                    Open it on the device that will host your sandbox. Your workspace opens the moment it connects.
                </span>
            </p>
<!-- Quiet, because the common reason to press it twice is impatience with a mail that is already on its way. -->
            <button type="button" :class="ui.linkButton(`text-muted underline hover:text-content`)" :disabled="sending" v-action="send">
                {{ sending ? `Sending…` : `Send it again` }}
            </button>
        </template>
        <Button v-else label="Email me the link" class="w-full justify-center" :loading="sending" :disabled="sending" @click="send">
            <template #icon><Icon name="envelope" /></template>
        </Button>

        <Notice v-if="error" :of="error" />
    </div>
</template>
