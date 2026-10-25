<!-- The shelves of the Automations page: everything, then one row per group, so a long list is navigated by what the jobs are for. -->
<script lang="ts">
import type { ShelfKind } from "./grouping";

// What the rail draws for a shelf, counted; the `all` row is one of these with the key ``.
export interface RailShelf {
    readonly key: string;
    readonly label: string;
    readonly kind: ShelfKind | `all`;
    readonly total: number;
    readonly on: number;
    readonly failing: number;
}
</script>

<script setup lang="ts">
import { Icon, type IconName, type NavGroup, NavRail, Picker, type PickerOptions, Row, useDevice, useRailMemory } from "@intentic/extension-ui";
import { computed } from "vue";
import { t } from "../i18n.js";

const { all, shelves } = defineProps<{
    /** The pinned everything row, the state the rail returns to. */
    all: RailShelf;
    shelves: readonly RailShelf[];
}>();

const selected = defineModel<string>({ required: true });

// What a shelf is filed by, as its glyph: a group somebody named, the code chores, a persona, or the remainder.
const SHELF_ICON = {
    all: `automations`,
    group: `folder`,
    chores: `maintenance`,
    persona: `user`,
    other: `boxes`,
} as const satisfies Record<RailShelf[`kind`], IconName>;

// Last shelf worked, kept across visits, checked against the shelves there are now so an emptied one won't reopen blank.
const picked = useRailMemory(`automations.shelf`, selected, () => shelves.map((shelf) => shelf.key));

// One unlabelled group: a heading would name a distinction the rail doesn't make.
const groups = computed<NavGroup<RailShelf>[]>(() => [{ key: `shelves`, items: [...shelves] }]);

// The count's hover card: failing first, since that is why anyone hovers it; a zero row is left out.
const countTip = (shelf: RailShelf) => ({
    title: shelf.label,
    rows: [
        { label: t(`automationRail.failing`), value: shelf.failing > 0 ? shelf.failing : ``, tone: `danger` as const },
        { label: t(`automationRail.on`), value: shelf.on },
        { label: t(`automationRail.total`), value: shelf.total },
    ],
});

const { mobile } = useDevice();

// The rail's same model as a picker, the count as a quiet description.
const options = computed<PickerOptions<string>>(() => [
    { options: [{ value: ``, label: all.label, description: String(all.total), icon: SHELF_ICON.all }] },
    {
        label: t(`automationRail.groups`),
        options: shelves.map((shelf) => ({ value: shelf.key, label: shelf.label, description: String(shelf.total), icon: SHELF_ICON[shelf.kind] })),
    },
]);
</script>

<template>
    <Picker v-if="mobile" v-model="picked" :options="options" :aria-label="t(`automationRail.group`)" :header="t(`automationRail.show`)" class="w-full text-xs" />

    <NavRail v-else :aria-label="t(`automationRail.groups`)" :groups="groups">
        <!-- Ungrouped so it can't be pushed out of reach: this is the state the rail always returns to. -->
        <template #pinned>
            <Row as="button" density="dense" :icon="SHELF_ICON.all" :title="all.label" :selected="picked === ``" class="rounded-md" @click="picked = ``">
                <template #meta>
                    <span class="flex items-center gap-1.5 tabular-nums" v-tooltip.bottom="countTip(all)">
                        <span v-if="all.failing > 0" class="size-1.5 rounded-full bg-danger" aria-hidden="true"></span>{{ all.total }}
                    </span>
                </template>
            </Row>
        </template>

        <template #row="{ item: shelf }">
            <Row
                :key="shelf.key"
                as="button"
                density="dense"
                :icon="SHELF_ICON[shelf.kind]"
                :title="shelf.label"
                :selected="picked === shelf.key"
                class="rounded-md"
                @click="picked = shelf.key"
            >
                <!-- A red point beside the count, not a red count: the number is still how many, and the point says some of them broke. -->
                <template #meta>
                    <span class="flex items-center gap-1.5 tabular-nums" v-tooltip.bottom="countTip(shelf)">
                        <span v-if="shelf.failing > 0" class="size-1.5 rounded-full bg-danger" aria-hidden="true"></span>{{ shelf.total }}
                    </span>
                </template>
            </Row>
        </template>

        <template #footer>
            <span class="flex items-start gap-1.5 text-2xs text-subtle">
                <Icon name="info-circle" class="shrink-0" />
                <span>{{ t(`automationRail.howFiled`) }}</span>
            </span>
        </template>
    </NavRail>
</template>
