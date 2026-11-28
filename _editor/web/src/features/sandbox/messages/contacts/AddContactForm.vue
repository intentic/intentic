<script setup lang="ts">
import { S2S_NOTE_MAX } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, InfoHint, Notice, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { ref, shallowRef } from "vue";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { contactsChanged } from "../../../../models/messages/useMessages";

// ADD BY ADDRESS, the handshake: the address is resolved (its domain's record, else the host itself), its key pinned
// provisionally, and a request sent with the note, offering messages. The contact appears waiting for their accept.

const emit = defineEmits<{ done: []; cancel: [] }>();

const t = useT();
const api = useMessagesApi();

const address = ref(``);
const note = ref(``);
const sending = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();

const submit = async (): Promise<void> => {
    const typed = address.value.trim();
    if (typed === `` || sending.value) {
        return;
    }
    sending.value = true;
    notice.value = undefined;
    try {
        const said = note.value.trim();
        await api.addContact(said === `` ? { address: typed, grants: {} } : { address: typed, note: said, grants: {} });
        await contactsChanged();
        emit(`done`);
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.add.failed`, { address: typed }));
    } finally {
        sending.value = false;
    }
};
</script>

<template>
    <form class="flex flex-col gap-3" data-add-contact @submit.prevent="submit">
        <label class="flex flex-col gap-1">
            <span class="flex items-center gap-1 text-xs text-muted">
                {{ t(`sandbox.messages.add.address`) }}
                <InfoHint :label="t(`sandbox.messages.add.address`)">
                    <span class="block text-xs text-content">{{ t(`sandbox.messages.add.addressHint`) }}</span>
                </InfoHint>
            </span>
            <input v-model="address" type="text" autocomplete="off" autofocus spellcheck="false" placeholder="research-7f2.intentic.app" :class="ui.input({ size: `sm` }, `max-w-sm font-mono`)" />
        </label>
        <label class="flex flex-col gap-1">
            <span class="flex items-center gap-1 text-xs text-muted">
                {{ t(`sandbox.messages.add.note`) }}
                <InfoHint :label="t(`sandbox.messages.add.note`)">
                    <span class="block text-xs text-content">{{ t(`sandbox.messages.add.noteHint`) }}</span>
                </InfoHint>
            </span>
            <textarea v-model="note" rows="2" :maxlength="S2S_NOTE_MAX" :class="ui.input({ size: `sm` }, `w-full resize-y`)" />
        </label>
        <Notice v-if="notice" :of="notice" />
        <div class="flex items-center justify-end gap-2">
            <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="sending" @click="emit(`cancel`)" />
            <Button tier="accent" type="submit" size="small" :label="t(`sandbox.messages.add.send`)" :loading="sending" :disabled="sending || address.trim() === ``">
                <template #icon><Icon name="send" /></template>
            </Button>
        </div>
    </form>
</template>
