<!--
    Platform navigation for the approvals queue, bounded by how many platforms a workspace posts to, not by queue length. Narrows the queue rather
    than replacing it — 'All approvals' stays the default. Each row shows one count, its size; whether something is waiting is the row's colour, not
    a second number.
-->
<script lang="ts">
import type { IconName } from "@intentic/extension-ui";

export interface ApprovalScope {
    /** A platform id, `actions` for action rows; `` spells everything, so the URL omits the parameter. */
    readonly key: string;
    readonly label: string;
    /** Brand slug from the posting capability's catalog; absent with no connector installed, or for actions. */
    readonly logo?: string;
    /** A glyph for the rows that are not a platform: everything, actions, held automations. */
    readonly icon?: IconName;
    readonly total: number;
    /** Proposed: waiting for a yes. */
    readonly waiting: number;
    readonly failed: number;
}
</script>

<script setup lang="ts">
import { BrandMark, type NavGroup, NavRail, Picker, type PickerOptions, Row, useDevice, useRailMemory } from "@intentic/extension-ui";
import { computed } from "vue";

const { all, scopes } = defineProps<{
    /** The pinned everything row: the state the rail returns to. */
    all: ApprovalScope;
    /** One row per platform the queue holds, plus the actions row when it holds any. */
    scopes: readonly ApprovalScope[];
}>();

const selected = defineModel<string>({ required: true });

// Last slice worked, kept across visits, checked against current slices so an emptied one won't reopen blank.
useRailMemory(`approvals.scope`, selected, () => scopes.map((scope) => scope.key));

// Single unlabelled group: a heading here would name a distinction the rail doesn't make.
const groups = computed<NavGroup<ApprovalScope>[]>(() => [{ key: `scopes`, items: [...scopes] }]);

const tone = (scope: ApprovalScope): string => (scope.failed > 0 ? `text-danger` : scope.waiting > 0 ? `text-warning` : ``);

// Tooltip text for the row's number: failed first, then waiting, then the slice's plain size.
const note = (scope: ApprovalScope): string => {
    const parts: string[] = [];
    if (scope.failed > 0) {
        parts.push(`${scope.failed} failed`);
    }
    if (scope.waiting > 0) {
        parts.push(`${scope.waiting} waiting for your review`);
    }
    parts.push(`${scope.total} in all`);
    return parts.join(` · `);
};

const { mobile } = useDevice();

// Same model as the rail, row number as a quiet description; brand marks come via the Picker's `#icon` slot.
const options = computed<PickerOptions<string>>(() => [
    { options: [{ value: ``, label: all.label, description: String(all.total), icon: all.icon }] },
    {
        label: `Slices`,
        options: scopes.map((scope) => ({ value: scope.key, label: scope.label, description: String(scope.total), icon: scope.icon })),
    },
]);
const scopeOf = (value: string | undefined): ApprovalScope | undefined => scopes.find((scope) => scope.key === value);
</script>

<template>
    <Picker v-if="mobile" v-model="selected" :options="options" aria-label="Approval slice" header="Show" class="w-full text-xs">
        <template #icon="{ option }">
            <BrandMark v-if="scopeOf(option?.value)?.logo" :size="16" :name="option?.label ?? ``" :logo="scopeOf(option?.value)?.logo" />
            <Icon v-else-if="option?.icon !== undefined" :name="option.icon" class="shrink-0 text-xs text-muted" aria-hidden="true" />
            <BrandMark v-else-if="option?.value" :size="16" :name="option.label" />
        </template>
    </Picker>

    <NavRail v-else aria-label="Approval slices" :groups="groups">
        <!-- Ungrouped so it can't be pushed out of reach: this is the state the rail always returns to. -->
        <template #pinned>
            <Row
                as="button"
                density="dense"
                :icon="all.icon"
                :title="all.label"
                :selected="selected === ``"
                class="rounded-md"
                @click="selected = ``"
            >
                <template #meta>
                    <span v-tooltip.bottom="note(all)" :class="tone(all)">{{ all.total }}</span>
                </template>
            </Row>
        </template>

        <!--
            The platform's own brand mark, the same object its posts lead with, so a slice and its posts are recognised together. The actions row has
            no brand, so it wears a glyph instead.
        -->
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
                <template v-if="scope.icon === undefined" #lead><BrandMark :size="18" :name="scope.label" :logo="scope.logo" /></template>
                <template #meta>
                    <span v-tooltip.bottom="note(scope)" :class="tone(scope)">{{ scope.total }}</span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
