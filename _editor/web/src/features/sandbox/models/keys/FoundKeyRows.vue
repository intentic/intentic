<script setup lang="ts">
import { Button, Notice, Row, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import { KEY_SOURCE_LABELS, keysFoundFor, type TileKey } from "../providerGrid";
import { FOUND_KEYS } from "../useFoundKeys";

// THE KEYS A LOOK FOUND ON THE OWNER'S COMPUTERS, offered in the card of the tile each belongs to (an Anthropic key under
// Claude, a gateway's under Local models), one Add each. The look itself is the grid's Find API keys (SandboxModels.vue),
// which holds the answer; a key once added leaves this list for the connection row it became. Drawn inside the card's
// <RowGroup>, which this template cannot see.

const t = useT();

const { tile } = defineProps<{ tile: TileKey }>();

const found = inject(FOUND_KEYS, undefined);
const rows = computed(() => (found === undefined ? [] : keysFoundFor(found.keyRows.value, tile)));
// A copy that failed is said here only when it was one of this card's keys.
const failure = computed(() => {
    const failed = found?.failedKey.value;
    return failed !== undefined && rows.value.some((key) => key.id === failed) ? found?.keyNotice.value : undefined;
});
</script>

<template>
    <template v-if="found">
        <RowNote v-if="failure" variant="block">
            <Notice :of="failure" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="found.dismissNotice()" />
        </RowNote>
        <Row
            v-for="key in rows"
            :key="key.id"
            icon="key"
            :title="t(`connect.connect.foundKeyTitle`, { provider: key.label })"
            :description="t(`connect.connect.foundKeyFrom`, { source: KEY_SOURCE_LABELS[key.source], host: key.host, hint: key.hint })"
        >
            <template #control>
                <Button
                    tier="boring"
                    size="small"
                    :label="t(`ui.action.add`)"
                    :loading="found.adding.value === key.id"
                    :disabled="found.adding.value !== undefined"
                    @click="found.addKey(key)"
                />
            </template>
        </Row>
    </template>
</template>
