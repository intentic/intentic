<!-- WHICH SLICE OF THE CATALOG: the capabilities view's primary navigation, and the reason the grid can stay a
     grid.

     This is bounded by how many CATEGORIES there are, never by how many capabilities we ship. That is the whole
     answer to the shape this page grows into: the catalog was one scroll with every section stacked in it, which
     is fine at forty cards and unreadable at two hundred, and every extension that gets enabled adds more. The
     rail stays ten rows while the catalog behind it grows without limit, and picking one makes the grid finite.

     It NARROWS rather than selects: every tile on the right is a real card whether you came via "All capabilities"
     or via one category. So <SplitView> folds it above the grid once the pane is too narrow for both (the default
     mobile="collapse") rather than covering it, and this swaps itself to a Picker at that width: the app's
     standard compact swap.

     The pinned rows are the two questions this page is actually opened with: "what have I already got" and "what
     should I add", which no category can answer, because both cut across all of them. They are rows rather than a
     second control beside the rail because they are the same kind of choice as a category: one slice of one catalog.

     ONE NUMBER PER ROW, and what is CONNECTED is its colour rather than a second number beside it. Two numbers in a
     16rem column read as "2 12" with nothing saying which is which, and the reader who needs the distinction is
     scanning, not hovering. Tint is what the tiles already use for the same fact (a connected card wears a success
     check), so the rail and the grid say it the same way; the tooltip is where the split is spelled out, because
     that is a question you ask of one row at a time. -->
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
    /** Spells the number out, for a slice whose total is not a count of cards: see the Connected row, which
     *  counts CONNECTIONS so its number matches the list it opens. Without this the tooltip would derive a
     *  sentence from two figures that no longer mean what it assumes. */
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

// Which slice you were last browsing, kept across visits: the pinned ones included, since "Connected" is as
// much a place somebody works from as any category is.
useRailMemory(`capabilities.category`, selected, () => [...pinned, ...categories].map((scope) => scope.key));

// One unlabelled group: a heading over the only group in the rail names a distinction that is not being made.
const groups = computed<NavGroup<CapabilityScope>[]>(() => [{ key: `categories`, items: [...categories] }]);

const tone = (scope: CapabilityScope): string => (scope.connected > 0 ? `text-success` : ``);
const meta = (scope: CapabilityScope): string =>
    scope.meta ?? (scope.connected === 0 ? `${scope.total} capabilities` : `${scope.total} capabilities · ${scope.connected} connected`);

// Asked of the split above, not of the screen: the grid beside this rail is only as wide as the workspace pane.
const compact = useCompact();

// The same model as options. `description` carries the count the rail shows in its right column.
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
        <!-- Not members of any group, so they cannot be grouped away: "all" is the state the rail returns to, and
             a row you cannot get back to is a filter you cannot clear. -->
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
