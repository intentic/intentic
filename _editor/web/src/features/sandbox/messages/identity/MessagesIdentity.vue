<script setup lang="ts">
import { Await, Button, ConfirmDialog, CopyButton, InfoHint, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { formatDate } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useTier } from "../../../../client/sandbox/useTier";
import Fingerprint from "../../../../parts/messages/Fingerprint.vue";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { useMe } from "../../../../models/messages/useMessages";
import DomainRows from "./DomainRows.vue";
import RecoveryKey from "./RecoveryKey.vue";
import { useIdentityWrite } from "./useIdentityWrite";

// MESSAGES ▸ IDENTITY: what other sandboxes know this one by. Its address and the fingerprint of its key, set to be read
// aloud to whoever adds it; the key's age and the rotation that replaces it (vouched for by the old one, every contact
// told); the own domains it may be addressed by, each with the TXT record to publish; and, for the owner alone, the
// recovery key that brings the identity back if the sandbox's volume is lost. A maintainer's, as the daemon floors it.

const t = useT();
const api = useMessagesApi();
const { canShip, isOwner } = useTier();
const { me, loaded } = useMe(canShip);
const document = computed(() => me.value?.document);

const { busy, notice, run } = useIdentityWrite();
const rotating = ref(false);
const rotate = async (): Promise<void> => {
    if (await run(`rotate`, () => api.rotate(), t(`sandbox.messages.identity.rotateFailed`))) {
        rotating.value = false;
    }
};
const keyLine = computed(() => {
    const issued = document.value?.issuedAt;
    const previous = me.value?.previousKeys ?? 0;
    return [
        ...(issued === undefined ? [] : [t(`sandbox.messages.identity.issued`, { date: formatDate(issued) })]),
        ...(previous > 0 ? [t(`sandbox.messages.identity.previous`, { count: previous }, previous)] : []),
    ].join(` · `);
});
</script>

<template>
    <Await :of="loaded">
        <div v-if="me && document" class="flex flex-col gap-6">
            <RowGroup :label="t(`sandbox.messages.identity.title`)">
                <template #info>
                    <InfoHint :label="t(`sandbox.messages.identity.about`)">
                        <span class="block text-xs text-content">{{ t(`sandbox.messages.identity.aboutBody`) }}</span>
                    </InfoHint>
                </template>
                <Row icon="globe" :title="t(`sandbox.messages.identity.address`)" :description="document.host">
                    <template #control><CopyButton :text="document.host" :aria-label="t(`sandbox.messages.identity.copyAddress`)" /></template>
                </Row>
                <RowNote variant="block">
                    <div class="flex flex-col gap-2" data-own-fingerprint>
                        <span class="flex items-center gap-1 text-xs text-muted">
                            {{ t(`sandbox.messages.identity.fingerprint`) }}
                            <InfoHint :label="t(`sandbox.messages.identity.fingerprint`)">
                                <span class="block text-xs text-content">{{ t(`sandbox.messages.identity.fingerprintHint`) }}</span>
                            </InfoHint>
                        </span>
                        <Fingerprint :fingerprint="document.fingerprint" size="lg" />
                    </div>
                </RowNote>
                <Row icon="key" :title="t(`sandbox.messages.identity.key`)" :description="keyLine">
                    <template #control>
                        <Button :label="t(`sandbox.messages.identity.rotate`)" size="small" tier="boring" :disabled="busy !== undefined" @click="rotating = true">
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                    </template>
                </Row>
                <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>
            </RowGroup>

            <DomainRows :domains="me.domains" />
            <RecoveryKey v-if="isOwner" :me="me" />

            <ConfirmDialog
                :open="rotating"
                :header="t(`sandbox.messages.identity.rotateAsk`)"
                :description="t(`sandbox.messages.identity.rotateWhat`)"
                :confirm-label="t(`sandbox.messages.identity.rotate`)"
                confirm-icon="refresh"
                tone="warning"
                :loading="busy === `rotate`"
                @confirm="rotate"
                @cancel="rotating = false"
            />
        </div>
    </Await>
</template>
