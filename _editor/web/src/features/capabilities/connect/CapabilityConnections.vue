<!-- Lists connected capability instances as individual rows, not catalog tiles — one tile can back several connections (three SSH boxes, two accounts). -->

<script lang="ts">
import type { IconName, StatusVariant } from "@intentic/ui";

export interface CapabilityConnection {
    /** The name its owner typed, or the tile's own name if they never typed one (a singleton tile uses its id). */
    readonly title: string;
    /** Tile it came from; omitted when the title already is the tile, so no row says "docker / Docker". */
    readonly tile?: string;
    /** Where the row leads. */
    readonly entryId: string;
    /** Distinguishes two rows that came from the same tile and would otherwise share a key. */
    readonly id: string;
    readonly logo?: string;
    readonly icon: IconName;
    /** What tells this one apart from another of the same tile: a host, an account, a database. May be empty. */
    readonly detail: string;
    /** The state in the reader's words ("ready", "offline", "needs sign-in"), and the tint it earns. */
    readonly state: string;
    readonly tone: StatusVariant;
    /** What is still missing, when something is: the daemon's own sentence, already written for a reader. */
    readonly note?: string;
/** A code to type on another device to finish this connection. */
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
const emit = defineEmits<{ open: [entryId: string, connectionId: string] }>();
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Grouped by category, so the rail's headings match the catalog's. -->
        <RowGroup v-for="group in groups" :key="group.label" :label="group.label">
            <Row v-for="row in group.rows" :key="`${row.entryId}:${row.id}`" as="button" chevron @click="emit(`open`, row.entryId, row.id)">
                <!-- Mark size comes from the group's tier now. -->
                <template #lead="{ mark }">
                    <BrandMark :size="mark" :name="row.title" :logo="row.logo" :icon="row.icon" />
                </template>
<!-- The name leads: the one word the owner chose, and what distinguishes multiple connections on one tile. -->
                <template #title>{{ row.title }}</template>
                <!-- Conditional so a row with nothing to say doesn't reserve an empty second line. -->
                <template v-if="row.tile !== undefined || row.detail !== `` || row.note !== undefined" #description>
                    <span v-if="row.tile">{{ row.tile }}</span>
                    <!-- Mono because it is an address, and addresses are compared character by character. -->
                    <span v-if="row.detail" class="font-mono text-subtle"><span v-if="row.tile"> · </span>{{ row.detail }}</span>
                    <!-- Beside the facts, not instead of them: a missing item doesn't replace the identifying details. -->
                    <span v-if="row.note" class="text-warning">
                        <span v-if="row.tile || row.detail"> · </span>
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
