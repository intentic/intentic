<script setup lang="ts">
import { S2S_NOTE_MAX, type S2sClaims } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, InfoHint, Notice, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import ClaimsFields from "../../../../parts/messages/ClaimsFields.vue";
import { claimsFrom, defaultUntilDate, earliestUntilDate, fieldsFrom, latestUntilDate, validUntilOf } from "../../../../models/messages/attestations";
import { type S2sAttestationIssueInput, useMessagesApi } from "../../../../models/messages/messagesApi";
import { threadsChanged } from "../../../../models/messages/useMessages";

// VOUCH FOR A CONTACT: what this sandbox checked about it, signed now with this sandbox's key for the key the contact is
// pinned under, valid until the date picked (a year at most), and sent to it, where a person there may add it to their
// sandbox's identity. Opened from a contact, or from its request in a thread, whose claims it starts from and which it
// answers in the same thread. Nothing is signed until Sign and send is pressed.

const props = defineProps<{
    contact: string;
    contactName: string;
    /** The claims a request asked for, to start from. */
    claims?: S2sClaims;
    /** The request it answers. */
    replyTo?: string;
}>();
const emit = defineEmits<{ done: []; cancel: [] }>();

const t = useT();
const api = useMessagesApi();

const now = Date.now();
const fields = ref(fieldsFrom(props.claims));
const until = ref(defaultUntilDate(now));
const note = ref(``);
const sending = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const validUntil = computed(() => validUntilOf(until.value, Date.now()));

const submit = async (): Promise<void> => {
    const lapses = validUntil.value;
    if (lapses === undefined || sending.value) {
        return;
    }
    sending.value = true;
    notice.value = undefined;
    try {
        const issue: S2sAttestationIssueInput = { contact: props.contact, claims: claimsFrom(fields.value), validUntil: lapses };
        const said = note.value.trim();
        if (said !== ``) {
            issue.note = said;
        }
        if (props.replyTo !== undefined) {
            issue.replyTo = props.replyTo;
        }
        const outcome = await api.issueVouch(issue);
        await threadsChanged();
        if (outcome.state === `refused`) {
            notice.value = noticeFrom(new Error(outcome.reason), t(`sandbox.messages.attestations.vouchFailed`, { name: props.contactName }));
            return;
        }
        emit(`done`);
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.attestations.vouchFailed`, { name: props.contactName }));
    } finally {
        sending.value = false;
    }
};
</script>

<template>
    <form class="flex flex-col gap-3" data-vouch-form @submit.prevent="submit">
        <div class="flex flex-col gap-1.5">
            <span class="flex items-center gap-1 text-xs text-muted">
                {{ t(`sandbox.messages.attestations.claims`) }}
                <InfoHint :label="t(`sandbox.messages.attestations.claims`)">
                    <span class="block text-xs text-content">{{ t(`sandbox.messages.attestations.claimsHint`) }}</span>
                </InfoHint>
            </span>
            <ClaimsFields v-model="fields" :disabled="sending" />
        </div>
        <label class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-xs text-muted">{{ t(`sandbox.messages.attestations.validUntil`) }}</span>
            <input v-model="until" type="date" required :min="earliestUntilDate(now)" :max="latestUntilDate(now)" :disabled="sending" :class="ui.input({ size: `sm` }, `w-56`)" />
        </label>
        <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{ t(`sandbox.messages.attestations.note`) }}</span>
            <textarea v-model="note" rows="2" :maxlength="S2S_NOTE_MAX" :disabled="sending" :class="ui.input({ size: `sm` }, `w-full resize-y`)" />
        </label>
        <Notice v-if="notice" :of="notice" />
        <div class="flex items-center justify-end gap-2">
            <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="sending" @click="emit(`cancel`)" />
            <Button tier="accent" type="submit" size="small" :label="t(`sandbox.messages.attestations.sign`)" :loading="sending" :disabled="sending || validUntil === undefined">
                <template #icon><Icon name="send" /></template>
            </Button>
        </div>
    </form>
</template>
