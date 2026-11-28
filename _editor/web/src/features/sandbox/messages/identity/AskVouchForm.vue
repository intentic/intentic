<script setup lang="ts">
import { S2S_NOTE_MAX } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, Notice, Picker, type PickerOption, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import ClaimsFields from "../../../../parts/messages/ClaimsFields.vue";
import { claimsFrom, fieldsFrom } from "../../../../models/messages/attestations";
import { type S2sAttestationAskInput, useMessagesApi } from "../../../../models/messages/messagesApi";
import { threadsChanged, useContacts } from "../../../../models/messages/useMessages";

// ASK A CONTACT TO VOUCH for this sandbox: one of its accepted contacts that is a sandbox as itself, the claims it is
// asked to vouch for, and a note on how it could check. The ask goes into that contact's thread; whatever comes back
// waits there for a person here to add to this identity.

const emit = defineEmits<{ done: []; cancel: [] }>();

const t = useT();
const api = useMessagesApi();
const { contacts } = useContacts();

const askable = computed(() => contacts.value.filter((contact) => contact.scope.kind === `sandbox` && contact.state === `accepted`));
const options = computed<readonly PickerOption<string>[]>(() => askable.value.map((contact) => ({ value: contact.id, label: contact.name, description: contact.address })));
const chosen = ref<string>();
const fields = ref(fieldsFrom());
const note = ref(``);
const sending = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const nameOf = (id: string): string => askable.value.find((contact) => contact.id === id)?.name ?? id;

const submit = async (): Promise<void> => {
    const contact = chosen.value;
    if (contact === undefined || sending.value) {
        return;
    }
    sending.value = true;
    notice.value = undefined;
    try {
        const ask: S2sAttestationAskInput = { contact, claims: claimsFrom(fields.value) };
        const said = note.value.trim();
        if (said !== ``) {
            ask.note = said;
        }
        const outcome = await api.askVouch(ask);
        await threadsChanged();
        if (outcome.state === `refused`) {
            notice.value = noticeFrom(new Error(outcome.reason), t(`sandbox.messages.attestations.askFailed`, { name: nameOf(contact) }));
            return;
        }
        emit(`done`);
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.attestations.askFailed`, { name: nameOf(contact) }));
    } finally {
        sending.value = false;
    }
};
</script>

<template>
    <p v-if="askable.length === 0" class="text-xs text-muted" data-ask-vouch>{{ t(`sandbox.messages.attestations.noContacts`) }}</p>
    <form v-else class="flex flex-col gap-3" data-ask-vouch @submit.prevent="submit">
        <label class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-xs text-muted">{{ t(`sandbox.messages.attestations.contact`) }}</span>
            <Picker
                v-model="chosen"
                :options="options"
                variant="input"
                :aria-label="t(`sandbox.messages.attestations.contact`)"
                :header="t(`sandbox.messages.attestations.contact`)"
                :placeholder="t(`sandbox.messages.attestations.pickContact`)"
                class="ui-field-sm w-56"
            />
        </label>
        <ClaimsFields v-model="fields" :disabled="sending" />
        <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{ t(`sandbox.messages.attestations.note`) }}</span>
            <textarea v-model="note" rows="2" :maxlength="S2S_NOTE_MAX" :disabled="sending" :class="ui.input({ size: `sm` }, `w-full resize-y`)" />
        </label>
        <Notice v-if="notice" :of="notice" />
        <div class="flex items-center justify-end gap-2">
            <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="sending" @click="emit(`cancel`)" />
            <Button tier="accent" type="submit" size="small" :label="t(`sandbox.messages.attestations.send`)" :loading="sending" :disabled="sending || chosen === undefined">
                <template #icon><Icon name="send" /></template>
            </Button>
        </div>
    </form>
</template>
