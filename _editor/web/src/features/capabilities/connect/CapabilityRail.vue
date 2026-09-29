<!-- Category navigation for the capabilities catalog, bounded by category count rather than how many capabilities exist. -->
<script lang="ts">
import type { IconName, Tip } from "@intentic/ui";

export interface CapabilityScope {
    /** `` is the spelling of "no filter": the URL simply omits the parameter. */
    readonly key: string;
    readonly label: string;
    readonly icon: IconName;
    /** Tiles in this slice. */
    readonly total: number;
    /** How many of them already have a connection. */
    readonly connected: number;
    /** For a slice whose total isn't a tile count (Connected counts connections): how many tiles those span. */
    readonly tiles?: number;
}
</script>

<script setup lang="ts">
import { type NavGroup, NavRail, Picker, type PickerOptions, Row, useCompact, useRailMemory } from "@intentic/ui";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

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
const meta = (scope: CapabilityScope): Tip =>
    scope.tiles === undefined
        ? {
              title: scope.label,
              rows: [
                  { label: t(`capabilities.capabilityRail.capabilities`), value: scope.total },
                  { label: t(`capabilities.capabilityRail.connected`), value: scope.connected === 0 ? `` : scope.connected },
              ],
          }
        : {
              title: scope.label,
              rows: [
                  { label: t(`capabilities.capabilityRail.connections`), value: scope.total },
                  { label: t(`capabilities.capabilityRail.capabilities`), value: scope.tiles },
              ],
          };

// Asked of the split above, not of the screen: the grid beside this rail is only as wide as the workspace pane.
const compact = useCompact();

// Same model as options; `description` carries the count shown in the Picker's right column.
const options = computed<PickerOptions<string>>(() => [
    { options: pinned.map((scope) => ({ value: scope.key, label: scope.label, description: String(scope.total), icon: scope.icon })) },
    {
        label: t(`capabilities.capabilityRail.categories`),
        options: categories.map((scope) => ({ value: scope.key, label: scope.label, description: String(scope.total), icon: scope.icon })),
    },
]);
</script>

<template>
    <Picker
        v-if="compact"
        v-model="selected"
        :options="options"
        :aria-label="t(`capabilities.capabilityRail.capabilityCategory`)"
        :header="t(`shared.category`)"
        class="w-full text-xs"
    />

    <NavRail v-else :aria-label="t(`capabilities.capabilityRail.capabilityCategories`)" :groups="groups">
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
