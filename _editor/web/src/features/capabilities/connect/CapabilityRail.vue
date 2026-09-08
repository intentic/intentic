<!--
    Category navigation for the capabilities catalog, bounded by category count rather than how many capabilities exist. Narrows the grid rather than
    filtering it — every tile stays a real card. Connected state shows as tint on a category's count, not a second number.
-->
<script lang="ts">
import type { IconName } from "@intentic/ui";

export interface CapabilityScope {
    /** `` is the spelling of "no filter": the URL simply omits the parameter. */
    readonly key: string;
    readonly label: string;
    readonly icon: IconName;
    /** Cards in this slice. */
    readonly total: number;
    /** How many of them already have a connection. */
    readonly connected: number;
    /** Spells the number out for a slice whose total isn't a card count (e.g. Connected counts connections). */
    readonly meta?: string;
}
</script>

<script setup lang="ts">
import { type NavGroup, NavRail, Picker, type PickerOptions, Row, useCompact, useRailMemory } from "@intentic/ui";
import { computed } from "vue";

const { pinned, categories } = defineProps<{
    /** Slices that cut across every category: all, connected, recommended. */
    pinned: readonly CapabilityScope[];
    categories: readonly CapabilityScope[];
}>();

const selected = defineModel<string>({ required: true });

// Last-browsed slice persists across visits, pinned rows included.
useRailMemory(`capabilities.category`, selected, () => [...pinned, ...categories].map((scope) => scope.key));

// One unlabelled group: a heading over the only group in the rail names a distinction that is not being made.
const groups = computed<NavGroup<CapabilityScope>[]>(() => [{ key: `categories`, items: [...categories] }]);

const tone = (scope: CapabilityScope): string => (scope.connected > 0 ? `text-success` : ``);
const meta = (scope: CapabilityScope): string =>
    scope.meta ?? (scope.connected === 0 ? `${scope.total} capabilities` : `${scope.total} capabilities · ${scope.connected} connected`);

// Asked of the split above, not of the screen: the grid beside this rail is only as wide as the workspace pane.
const compact = useCompact();

// Same model as options; `description` carries the count shown in the Picker's right column.
const options = computed<PickerOptions<string>>(() => [
    { options: pinned.map((scope) => ({ value: scope.key, label: scope.label, description: String(scope.total), icon: scope.icon })) },
    {
        label: `Categories`,
        options: categories.map((scope) => ({ value: scope.key, label: scope.label, description: String(scope.total), icon: scope.icon })),
    },
]);
</script>

<template>
    <Picker v-if="compact" v-model="selected" :options="options" aria-label="Capability category" header="Category" class="w-full text-xs" />

    <NavRail v-else aria-label="Capability categories" :groups="groups">
        <!-- Not members of any group, so "all" can't be grouped away: it's the row a cleared filter returns to. -->
        <template #pinned>
            <Row
                v-for="scope in pinned"
                :key="scope.key"
                as="button"
                density="dense"
                :icon="scope.icon"
                :title="scope.label"
                :selected="selected === scope.key"
                class="rounded-md"
                @click="selected = scope.key"
            >
                <template #meta>
                    <span v-tooltip.bottom="meta(scope)" :class="tone(scope)">{{ scope.total }}</span>
                </template>
            </Row>
        </template>

        <template #row="{ item: scope }">
            <Row
                :key="scope.key"
                as="button"
                density="dense"
                :icon="scope.icon"
                :title="scope.label"
                :selected="selected === scope.key"
                class="rounded-md"
                @click="selected = scope.key"
            >
                <template #meta>
                    <span v-tooltip.bottom="meta(scope)" :class="tone(scope)">{{ scope.total }}</span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
