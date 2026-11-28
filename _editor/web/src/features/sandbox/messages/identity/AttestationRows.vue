<script setup lang="ts">
import type { S2sAttestationRow } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, ConfirmDialog, InfoHint, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatDate } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import ClaimsList from "../../../../parts/messages/ClaimsList.vue";
import { vouchFacts } from "../../../../models/messages/attestations";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { identityChanged, useAttestations } from "../../../../models/messages/useMessages";
import AskVouchForm from "./AskVouchForm.vue";

// VOUCHED FOR BY: what other sandboxes signed about this one and a person here added to its identity, each the sandbox
// that vouched, what it vouched for and until when. The document carries one only while it holds; one that lapsed, or was
// made for a key two rotations back, says so under its row until it is removed or vouched for again. Ask a contact opens
// the ask in place; what comes back waits in that contact's thread for a person to add it.

const t = useT();
const api = useMessagesApi();
const { attestations } = useAttestations(true);

interface Shown {
    readonly row: S2sAttestationRow;
    readonly title: string;
    readonly description: string;
    // Why the document does not carry it, when it does not: its lapse on the reader's calendar, else the daemon's words.
    readonly why?: string;
}
const whyOf = (row: S2sAttestationRow, validUntil: number | undefined): string | undefined => {
    if (row.published) {
        return undefined;
    }
    return validUntil !== undefined && validUntil <= Date.now()
        ? t(`sandbox.messages.attestations.lapsed`, { date: formatDate(validUntil) })
        : t(`sandbox.messages.attestations.notCarried`, { problem: row.problem ?? `` });
};
const shown = computed((): readonly Shown[] =>
    attestations.value.map((row) => {
        const facts = vouchFacts(row.attestation);
        const title = facts === undefined ? t(`sandbox.messages.attestations.otherType`, { type: row.attestation.type }) : facts.issuer;
        const description = facts === undefined ? `` : [facts.address, t(`sandbox.messages.attestations.until`, { date: formatDate(facts.validUntil) })].join(` · `);
        const why = whyOf(row, facts?.validUntil);
        return why === undefined ? { row, title, description } : { row, title, description, why };
    }),
);

const asking = ref(false);
const busy = ref<string>();
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const removing = shallowRef<Shown>();
const remove = async (): Promise<void> => {
    const target = removing.value;
    if (target === undefined || busy.value !== undefined) {
        return;
    }
    busy.value = target.row.id;
    notice.value = undefined;
    try {
        await api.removeAttestation(target.row.id);
        await identityChanged();
        removing.value = undefined;
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.attestations.removeFailed`));
        removing.value = undefined;
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <RowGroup :label="t(`sandbox.messages.attestations.title`)" data-attestations>
        <template #info>
            <InfoHint :label="t(`sandbox.messages.attestations.about`)">
                <span class="block text-xs text-content">{{ t(`sandbox.messages.attestations.aboutBody`) }}</span>
            </InfoHint>
        </template>
        <template #actions>
            <Button v-if="!asking" :label="t(`sandbox.messages.attestations.ask`)" size="small" tier="boring" @click="asking = true">
                <template #icon><Icon name="send" /></template>
            </Button>
        </template>

        <RowNote v-if="asking" variant="block">
            <AskVouchForm @done="asking = false" @cancel="asking = false" />
        </RowNote>

        <template v-for="each in shown" :key="each.row.id">
            <Row icon="shield" :title="each.title" :description="each.description" :data-attestation="each.row.id">
                <template #control>
                    <Button :label="t(`sandbox.messages.attestations.remove`)" size="small" tier="quiet" tone="danger" :disabled="busy !== undefined" @click="removing = each" />
                </template>
                <template #below>
                    <ClaimsList v-if="vouchFacts(each.row.attestation)" :claims="vouchFacts(each.row.attestation)?.claims ?? {}" />
                </template>
            </Row>
            <!-- Why the document does not carry it now: lapsed, or made for a key two rotations back. -->
            <RowNote v-if="each.why" icon="exclamation-triangle" tone="warning" :data-not-carried="each.row.id">{{ each.why }}</RowNote>
        </template>
        <RowNote v-if="shown.length === 0 && !asking" variant="empty">{{ t(`sandbox.messages.attestations.none`) }}</RowNote>
        <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>

        <ConfirmDialog
            :open="removing !== undefined"
            :header="t(`sandbox.messages.attestations.removeAsk`, { name: removing?.title ?? `` })"
            :description="t(`sandbox.messages.attestations.removeWhat`, { name: removing?.title ?? `` })"
            :confirm-label="t(`sandbox.messages.attestations.remove`)"
            confirm-icon="trash"
            destructive
            :loading="busy !== undefined"
            @confirm="remove"
            @cancel="removing = undefined"
        />
    </RowGroup>
</template>
