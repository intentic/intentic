<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { Button, Notice, type NoticeModel, RowNote } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useAccess } from "../../../../client/sandbox/access/useAccess";
import { useRole } from "../../../../client/sandbox/useRole";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { refreshConnections } from "../../../../models/conversations/accounts/useChat-accounts";
import { keysBeside } from "../../../../models/providers/providerCatalog";
import ConnectionRow from "../../secrets/ConnectionRow.vue";
import ApiKeyOption from "./ApiKeyOption.vue";
import { keyRows } from "./providerKeys";

// THE API KEYS A PROVIDER'S CARD HOLDS, as rows after its accounts (ProviderPanel.vue): a key pasted under the sign-in
// (ApiKeyOption) or copied from the owner's computer is one more way to pay for the same models, so it lives where they
// do rather than under Local models (the owner, 2026-11-05). Taking one off removes the endpoint it became, as the
// Capabilities page would; only a reader who may change connections gets the press. A card holding no key offers one
// instead, as its last quiet line, and a card holding one offers no second.

const t = useT();

const { provider, offer } = defineProps<{
    provider: AgentProvider;
    // Whether the card may offer a key at all: Full access, and no sign-in running in it.
    offer: boolean;
}>();
// The endpoint a key pasted here became, and its vendor's name, for the page's own "connected" answer.
const emit = defineEmits<{ added: [endpoint: AgentProvider, label: string] }>();

const { capabilities, remove } = useCapabilities();
const { canShip } = useRole();
const { can } = useAccess();
const mayRemove = computed(() => canShip.value || can(`capabilities.remove`));

const rows = computed(() => keyRows(provider, keysBeside(provider), capabilities.value ?? []));

const removing = ref<string | undefined>(undefined);
const notice = ref<NoticeModel | undefined>(undefined);

// The picker reads endpoints off the connection list, which still names this one until it is read again.
const disconnect = async (capability: string): Promise<void> => {
    if (removing.value !== undefined) {
        return;
    }
    removing.value = capability;
    notice.value = undefined;
    try {
        await remove.mutateAsync(capability);
        await refreshConnections();
    } catch (caught) {
        notice.value = noticeFrom(caught, t(`connect.providerKeys.couldntRemove`));
    } finally {
        removing.value = undefined;
    }
};
</script>

<template>
    <RowNote v-if="notice" variant="block">
        <Notice :of="notice" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="notice = undefined" />
    </RowNote>
    <!-- Drawn inside ProviderPanel's <RowGroup>, which this template cannot see: its tier, said here. -->
    <ConnectionRow
        v-for="row in rows"
        :key="row.provider"
        density="compact"
        :title="row.title"
        :state="row.state"
        :tone="row.state === `reauth` ? `warning` : `default`"
        :note="row.note"
        :note-busy="row.settling"
        :description="row.description"
    >
        <template #control>
            <Button
                v-if="mayRemove"
                :label="t(`ui.action.disconnect`)"
                size="small"
                tier="quiet"
                tone="danger"
                :loading="removing === row.capability"
                :disabled="removing !== undefined && removing !== row.capability"
                @click="disconnect(row.capability)"
            />
        </template>
    </ConnectionRow>
    <ApiKeyOption v-if="offer && rows.length === 0" :provider="provider" @added="(endpoint, label) => emit(`added`, endpoint, label)" />
</template>
