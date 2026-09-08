<!--
    Lists connected capability instances as individual rows, not catalog cards — one card can back several connections (three SSH boxes, two
    accounts). Rows needing attention sort first. A row opens that connection's settings on its source card; it holds no controls of its own.
-->

<script lang="ts">
import type { IconName, StatusVariant } from "@intentic/ui";

export interface CapabilityConnection {
    /** The name its owner typed, or the card's own name if they never typed one (a singleton card uses its id). */
    readonly title: string;
    /** Card it came from; omitted when the title already is the card, so no row says "docker / Docker". */
    readonly card?: string;
    /** Where the row leads. */
    readonly cardId: string;
    /** Distinguishes two rows that came from the same card and would otherwise share a key. */
    readonly id: string;
    readonly logo?: string;
    readonly icon: IconName;
    /** What tells this one apart from another of the same card: a host, an account, a database. May be empty. */
    readonly detail: string;
    /** The state in the reader's words ("ready", "offline", "needs sign-in"), and the tint it earns. */
    readonly state: string;
    readonly tone: StatusVariant;
    /** What is still missing, when something is: the daemon's own sentence, already written for a reader. */
    readonly note?: string;
    /**
     * A code to type on another device to finish this connection (e.g. a link-a-device code); shown big on the card it
     * leads to.
     */
    readonly code?: string;
}

export interface CapabilityConnectionGroup {
    readonly label: string;
    readonly rows: readonly CapabilityConnection[];
}
</script>

<script setup lang="ts">
import { BrandMark, Row, RowGroup, StatusBadge } from "@intentic/ui";

defineProps<{ groups: readonly CapabilityConnectionGroup[] }>();
const emit = defineEmits<{ open: [cardId: string, connectionId: string] }>();
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Grouped and counted by category, so the rail's headings match the catalog's. -->
        <RowGroup v-for="group in groups" :key="group.label" :label="group.label" :count="group.rows.length">
            <Row v-for="row in group.rows" :key="`${row.cardId}:${row.id}`" as="button" chevron @click="emit(`open`, row.cardId, row.id)">
                <!-- Mark size comes from the group's tier now. -->
                <template #lead="{ mark }">
                    <BrandMark :size="mark" :name="row.title" :logo="row.logo" :icon="row.icon" />
                </template>
                <!--
                    The name leads: the one word the owner chose, and what distinguishes multiple connections on one
                    card.
                -->
                <template #title>{{ row.title }}</template>
                <!-- Conditional so a row with nothing to say doesn't reserve an empty second line. -->
                <template v-if="row.card !== undefined || row.detail !== `` || row.note !== undefined" #description>
                    <span v-if="row.card">{{ row.card }}</span>
                    <!-- Mono because it is an address, and addresses are compared character by character. -->
                    <span v-if="row.detail" class="font-mono text-subtle"><span v-if="row.card"> · </span>{{ row.detail }}</span>
                    <!-- Beside the facts, not instead of them: a missing item doesn't replace the identifying details. -->
                    <span v-if="row.note" class="text-warning">
                        <span v-if="row.card || row.detail"> · </span>
                        <span v-if="row.code" class="font-mono font-semibold tracking-widest">{{ row.code }}</span>
                        <span v-if="row.code">: </span>{{ row.note }}
                    </span>
                </template>
                <template #meta>
                    <StatusBadge :variant="row.tone" size="xs" dot :label="row.state" />
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
