<script setup lang="ts">
import type { S2sDomainClaim } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, CopyButton, InfoHint, Notice, Row, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { useIdentityWrite } from "./useIdentityWrite";

// OWN DOMAINS: a domain the owner controls, as this sandbox's address. Each shows the exact TXT record to publish, its
// name and its value copied apart, until a check finds it; the daemon checks daily too, and lists the domain in its
// document only while the record matches. Check asks now; Remove lets the domain go.

defineProps<{ domains: readonly S2sDomainClaim[] }>();

const t = useT();
const api = useMessagesApi();
const { busy, notice, run } = useIdentityWrite();

const adding = ref(false);
const domain = ref(``);
const add = async (): Promise<void> => {
    const typed = domain.value.trim().toLowerCase();
    if (typed !== `` && (await run(`add`, () => api.addDomain(typed), t(`sandbox.messages.domains.addFailed`, { domain: typed })))) {
        domain.value = ``;
        adding.value = false;
    }
};
const check = (claim: S2sDomainClaim): Promise<boolean> => run(`check:${claim.domain}`, () => api.checkDomain(claim.domain), t(`sandbox.messages.domains.checkFailed`));
const remove = (claim: S2sDomainClaim): Promise<boolean> =>
    run(`remove:${claim.domain}`, () => api.removeDomain(claim.domain), t(`sandbox.messages.domains.removeFailed`, { domain: claim.domain }));

const lineOf = (claim: S2sDomainClaim): string => {
    if (claim.problem !== undefined) {
        return claim.problem;
    }
    return claim.checkedAt === undefined ? t(`sandbox.messages.domains.neverChecked`) : t(`sandbox.messages.domains.checked`, { ago: timeAgo(claim.checkedAt, { days: true }) });
};
</script>

<template>
    <RowGroup :label="t(`sandbox.messages.domains.title`)" data-domains>
        <template #info>
            <InfoHint :label="t(`sandbox.messages.domains.about`)">
                <span class="block text-xs text-content">{{ t(`sandbox.messages.domains.aboutBody`) }}</span>
            </InfoHint>
        </template>
        <template #actions>
            <Button v-if="!adding" :label="t(`sandbox.messages.domains.add`)" size="small" tier="boring" @click="adding = true">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <RowNote v-if="adding" variant="block">
            <form class="flex flex-wrap items-center gap-2" @submit.prevent="add">
                <input
                    v-model="domain"
                    type="text"
                    autocomplete="off"
                    autofocus
                    spellcheck="false"
                    placeholder="ada.example"
                    :aria-label="t(`sandbox.messages.domains.domain`)"
                    :class="ui.input({ size: `sm` }, `min-w-48 flex-1 font-mono`)"
                />
                <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="busy !== undefined" @click="adding = false" />
                <Button tier="accent" type="submit" size="small" :label="t(`sandbox.messages.domains.add`)" :loading="busy === `add`" :disabled="busy !== undefined || domain.trim() === ``" />
            </form>
        </RowNote>

        <Row v-for="claim in domains" :key="claim.domain" icon="globe" :title="claim.domain" :description="lineOf(claim)" :data-domain="claim.domain">
            <template #meta>
                <StatusBadge
                    :variant="claim.verified ? `success` : `warning`"
                    :label="claim.verified ? t(`sandbox.messages.domains.verified`) : t(`sandbox.messages.domains.waiting`)"
                    size="xs"
                    dot
                />
            </template>
            <template #control>
                <Button
                    :label="t(`sandbox.messages.domains.check`)"
                    size="small"
                    :tier="claim.verified ? `boring` : `accent`"
                    :loading="busy === `check:${claim.domain}`"
                    :disabled="busy !== undefined"
                    @click="check(claim)"
                />
                <Button :label="t(`sandbox.messages.domains.remove`)" size="small" tier="quiet" tone="danger" :disabled="busy !== undefined" @click="remove(claim)" />
            </template>
            <!-- The record to publish, until it is found: its name and value each copied apart, as a DNS form asks for them. -->
            <template v-if="!claim.verified" #below>
                <dl class="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-lg bg-canvas p-3 text-xs">
                    <dt class="text-subtle">{{ t(`sandbox.messages.domains.recordType`) }}</dt>
                    <dd class="col-span-2 font-mono text-content">TXT</dd>
                    <dt class="text-subtle">{{ t(`sandbox.messages.domains.recordName`) }}</dt>
                    <dd class="min-w-0 break-all font-mono text-content">{{ claim.record.name }}</dd>
                    <CopyButton :text="claim.record.name" :aria-label="t(`sandbox.messages.domains.copyName`)" />
                    <dt class="text-subtle">{{ t(`sandbox.messages.domains.recordValue`) }}</dt>
                    <dd class="min-w-0 break-all font-mono text-content">{{ claim.record.value }}</dd>
                    <CopyButton :text="claim.record.value" :aria-label="t(`sandbox.messages.domains.copyValue`)" />
                </dl>
            </template>
        </Row>
        <RowNote v-if="domains.length === 0 && !adding" variant="empty">{{ t(`sandbox.messages.domains.empty`) }}</RowNote>
        <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>
    </RowGroup>
</template>
