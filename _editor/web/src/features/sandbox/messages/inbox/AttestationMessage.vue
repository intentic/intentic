<script setup lang="ts">
import type { S2sThreadMessage } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, Notice } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatDate } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import { useTier } from "../../../../client/sandbox/useTier";
import ClaimsList from "../../../../parts/messages/ClaimsList.vue";
import { carriedFrom, vouchFacts } from "../../../../models/messages/attestations";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { identityChanged, useAttestations } from "../../../../models/messages/useMessages";
import VouchForm from "../contacts/VouchForm.vue";

// AN ATTESTATION IN A THREAD, inside its message: what a request asks to be vouched for, or what a vouch says and until
// when. Neither is acted on when it arrives. A received request offers its answer to the owner or a maintainer: a vouch,
// starting from the claims it asked for and sent back into this thread. A received vouch offers to add it to this
// sandbox's identity, which the daemon checks first, and says so once it is there.

const props = defineProps<{ message: S2sThreadMessage; contactName: string }>();

const t = useT();
const api = useMessagesApi();
const { canShip } = useTier();
const { attestations } = useAttestations(computed(() => canShip.value && props.message.kind === `attestation.issued` && props.message.direction === `in`));

const facts = computed(() => (props.message.attestation === undefined ? undefined : vouchFacts(props.message.attestation)));
const claims = computed(() => props.message.claims ?? facts.value?.claims ?? {});
const received = computed(() => props.message.direction === `in` && canShip.value);
const carried = computed(() => carriedFrom(attestations.value, props.message.id));

const vouching = ref(false);
const adding = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const add = async (): Promise<void> => {
    if (adding.value) {
        return;
    }
    adding.value = true;
    notice.value = undefined;
    try {
        await api.acceptAttestation(props.message.id);
        await identityChanged();
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.attestations.addFailed`));
    } finally {
        adding.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2" :data-attestation-message="message.kind">
        <ClaimsList :claims="claims" />
        <p v-if="facts" class="text-2xs text-subtle">{{ t(`sandbox.messages.attestations.until`, { date: formatDate(facts.validUntil) }) }}</p>

        <template v-if="received && message.kind === `attestation.request`">
            <VouchForm v-if="vouching" :contact="message.contact" :contact-name="contactName" :claims="claims" :reply-to="message.id" @done="vouching = false" @cancel="vouching = false" />
            <div v-else>
                <Button :label="t(`sandbox.messages.attestations.vouchShort`)" size="small" tier="boring" @click="vouching = true">
                    <template #icon><Icon name="shield" /></template>
                </Button>
            </div>
        </template>

        <template v-if="received && message.kind === `attestation.issued` && facts">
            <p v-if="carried" class="flex items-center gap-1 text-xs text-success" data-carried>
                <Icon name="check" class="size-3.5" />
                {{ t(`sandbox.messages.attestations.added`) }}
            </p>
            <div v-else>
                <Button :label="t(`sandbox.messages.attestations.addToIdentity`)" size="small" tier="accent" :loading="adding" :disabled="adding" @click="add">
                    <template #icon><Icon name="shield" /></template>
                </Button>
            </div>
        </template>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
