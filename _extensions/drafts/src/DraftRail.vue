<!-- WHICH PLATFORM'S QUEUE — the drafts view's index, and the reason the queue can stay one readable column.

     The page was a single scroll with every section stacked down it, which is fine for a handful of posts on one
     platform and unreadable the moment an agent is drafting for several: five sections deep in X posts is five
     sections you scroll past to reach the one Reddit thread waiting on a yes. The rail is bounded by how many
     platforms a workspace posts to — a handful, and a number that grows far slower than the queue behind it.

     IT NARROWS, IT DOES NOT SELECT. "All drafts" is where the page opens and where it returns to, because the
     first question this queue answers is "is anything waiting on me anywhere". So <SplitView> folds it above the
     body on a phone rather than covering it, and this swaps itself to a Picker at that width.

     ONE NUMBER PER ROW — how many drafts the slice holds, so the row says how big the list it opens is — and
     what is WAITING is its colour rather than a second number. Two numbers in a 16rem column read as "3 12" with
     nothing saying which is which, and a reader scanning the rail wants one glance, not an arithmetic. Red where
     something failed to post, amber where something wants a decision, quiet where the slice is on rails; the
     tooltip is where the split is spelled out, because that is a question you ask of one row at a time. -->
<script lang="ts">
export interface DraftScope {
    /** The platform id, and `` is the spelling of "every platform" — the URL simply omits the parameter. */
    readonly key: string;
    readonly label: string;
    /** Brand slug from the posting capability's catalog entry; absent for a platform with no connector installed. */
    readonly logo?: string;
    readonly total: number;
    /** Proposed — waiting for a yes. */
    readonly waiting: number;
    readonly failed: number;
}
</script>

<script setup lang="ts">
import { BrandMark, type NavGroup, NavRail, Picker, type PickerOptions, Row, useDevice, useRailMemory } from "@intentic/extension-ui";
import { computed } from "vue";

const { all, platforms } = defineProps<{
    /** The pinned everything row — the state the rail returns to. */
    all: DraftScope;
    platforms: readonly DraftScope[];
}>();

const selected = defineModel<string>({ required: true });

// Which platform's queue you were last working through, kept across visits. Validated against the platforms
// actually on offer, so a connector that has since been removed cannot open the page on an empty slice.
useRailMemory(`drafts.platform`, selected, () => platforms.map((scope) => scope.key));

// One unlabelled group: a heading over the only group in the rail names a distinction that is not being made.
const groups = computed<NavGroup<DraftScope>[]>(() => [{ key: `platforms`, items: [...platforms] }]);

const tone = (scope: DraftScope): string => (scope.failed > 0 ? `text-danger` : scope.waiting > 0 ? `text-warning` : ``);

// What the number would say if it had room. Ordered the way the queue owes it: broken first, then waiting, then
// the plain size of a slice that needs nothing.
const note = (scope: DraftScope): string => {
    const parts: string[] = [];
    if (scope.failed > 0) {
        parts.push(`${scope.failed} failed to post`);
    }
    if (scope.waiting > 0) {
        parts.push(`${scope.waiting} waiting for your review`);
    }
    parts.push(`${scope.total} ${scope.total === 1 ? `draft` : `drafts`} in all`);
    return parts.join(` · `);
};

const { mobile } = useDevice();

// The same model as options, with the row's number as the quiet right-hand annotation. The brand marks come
// through the Picker's #icon slot — a platform's logo is not something the icon set has.
const options = computed<PickerOptions<string>>(() => [
    { options: [{ value: ``, label: all.label, description: String(all.total), icon: `file-edit` }] },
    { label: `Platforms`, options: platforms.map((scope) => ({ value: scope.key, label: scope.label, description: String(scope.total) })) },
]);
const logoOf = (value: string | undefined): DraftScope | undefined => platforms.find((scope) => scope.key === value);
</script>

<template>
    <Picker v-if="mobile" v-model="selected" :options="options" aria-label="Draft platform" header="Platform" class="w-full text-xs">
        <template #icon="{ option }">
            <BrandMark v-if="logoOf(option?.value)" :size="16" :name="option?.label ?? ``" :logo="logoOf(option?.value)?.logo" />
            <Icon v-else-if="option?.icon !== undefined" :name="option.icon" class="shrink-0 text-xs text-muted" aria-hidden="true" />
        </template>
    </Picker>

    <NavRail v-else aria-label="Draft platforms" :groups="groups">
        <!-- Not a member of any group, so no grouping can push it out of reach: "all" is the state the rail
             returns to, and a row you cannot get back to is a filter you cannot clear. -->
        <template #pinned>
            <Row
                as="button"
                density="dense"
                icon="file-edit"
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

        <!-- The platform's own mark rather than a glyph: it is the same object the rows in the queue lead with,
             so a slice and the posts inside it are recognised by the same thing. -->
        <template #row="{ item: scope }">
            <Row
                :key="scope.key"
                as="button"
                density="dense"
                :title="scope.label"
                :selected="selected === scope.key"
                class="rounded-md"
                @click="selected = scope.key"
            >
                <template #lead><BrandMark :size="18" :name="scope.label" :logo="scope.logo" /></template>
                <template #meta>
                    <span v-tooltip.bottom="note(scope)" :class="tone(scope)">{{ scope.total }}</span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
