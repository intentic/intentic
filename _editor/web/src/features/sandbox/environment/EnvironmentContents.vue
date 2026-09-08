<script setup lang="ts">
import type { EnvironmentItem } from "@intentic/api-contract";
import { BrandMark, Code, DisclosureRow, Notice, RowGroup, RowNote, SkeletonRows, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import type { ContentsGroup } from "./useEnvironmentContents";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { environmentVisual } from "./environmentVisual";

// What this sandbox has, not its build recipe (one pill away). Decisions (agent-added, capability) get full rows; the
// base staples are a scannable strip, since nobody reads them, they only check for one. One line per row: name,
// versions and a truncated sentence; the full paragraph opens on click, never duplicating the row's own summary.

const { groups, loading, error } = defineProps<{
    groups: ContentsGroup[];
    loading: boolean;
    error?: string;
}>();

// Wrapped in computed since a destructured prop is a value, not a ref the gate can watch.
const outline = useSandboxOutline(computed(() => loading));

// Ids, not per-item flags, so the open/full-view sets survive a refetch that replaces the objects.
const open = ref(new Set<string>());
const full = ref(new Set<string>());
const flipped = (ids: Set<string>, id: string): Set<string> => {
    const next = new Set(ids);
    if (!next.delete(id)) {
        next.add(id);
    }
    return next;
};
const toggle = (id: string): void => {
    open.value = flipped(open.value, id);
};
const toggleFull = (id: string): void => {
    full.value = flipped(full.value, id);
};

const rowGroups = computed(() => groups.filter((group) => group.origin !== `base`));
const staples = computed(() => groups.find((group) => group.origin === `base`));

// Only one staple's sentence opens at a time: several at once would push the strip apart and break the scannable grid.
const picked = ref<string>();
const pick = (id: string): void => {
    picked.value = picked.value === id ? undefined : id;
};
const pickedItem = computed(() => staples.value?.items.find((item) => item.id === picked.value));

// At most 3 tool versions on a row; the rest are in the expansion.
const SHOWN_TOOLS = 3;
const shownTools = (item: EnvironmentItem): EnvironmentItem[`tools`] => item.tools.slice(0, SHOWN_TOOLS);

// Hides the tool name when the row has one tool named after itself (would repeat as both title and label).
const toolLabel = (item: EnvironmentItem, tool: EnvironmentItem[`tools`][number]): string =>
    item.tools.length === 1 && tool.name.toLowerCase() === item.name.toLowerCase() ? `` : tool.name;

// Where a version number came from, attached to the number itself rather than a preamble.
const provenance = (tool: EnvironmentItem[`tools`][number]): string => `Read by running ${tool.name} in this sandbox, just now`;

// No badge for `active`: it's the normal case, and marking it would drown the two states that matter.
const STATES = {
    active: undefined,
    "after-rebuild": { icon: `clock`, label: `arrives after rebuild`, tone: `text-warning` },
    "awaiting-approval": { icon: `sparkles`, label: `waiting for your approval`, tone: `text-link` },
} as const;
const stateOf = (item: EnvironmentItem) => STATES[item.state];

// Shows originLabel only when it doesn't just repeat the row's own name (e.g. 'workspace extension', not '<name>
// capability').
const attribution = (item: EnvironmentItem): string | undefined =>
    item.originLabel?.toLowerCase().startsWith(item.name.toLowerCase()) === false ? item.originLabel : undefined;

// The full paragraph an agent wrote (falls back to the row's own summary); never shown alongside the row's line, which
// is a trim of the same text.
const explanation = (item: EnvironmentItem): string => item.detail ?? item.purpose ?? ``;

// Splits at the agent's own paragraph break, not a line count, so 'there is more' is a fact about the text, not the
// render width.
const paragraphs = (item: EnvironmentItem): string[] => explanation(item).split(`\n\n`);
const opening = (item: EnvironmentItem): string => paragraphs(item)[0] ?? ``;
const rest = (item: EnvironmentItem): string => paragraphs(item).slice(1).join(`\n\n`);
// True whenever there is anything beyond the row's own line: detail, commands, or a plumbing extras count.
const expandable = (item: EnvironmentItem): boolean => item.detail !== undefined || item.commands !== undefined || item.extras !== undefined;

// Phrased as '3 items', not a bare number, so it doesn't read as another version beside the row's version numbers.
const countLabel = (group: ContentsGroup): string => `${group.items.length} ${group.items.length === 1 ? `item` : `items`}`;
</script>

<template>
    <!-- `gap-5` separates the sections, since none of them draws its own box any more. -->
    <div class="flex flex-col gap-5">
        <!-- `flat`: this list already sits inside the Environment group's own frame. -->
        <RowGroup v-for="group in rowGroups" :key="group.origin" flat undivided :label="group.label" :count="countLabel(group)">
            <!--
                The chevron sits in `#lead`, with the app's other expandable rows; `disabled` removes the arrow, hover and tab stop when nothing is
                expandable. The inner 'Show more' keeps its own chevron swap, since that's a text clamp, not this disclosure.
            -->

            <DisclosureRow
                v-for="item in group.items"
                :key="item.id"
                :disabled="!expandable(item)"
                :class="item.state === `after-rebuild` ? `opacity-70` : undefined"
                :open="open.has(item.id)"
                @update:open="toggle(item.id)"
            >
                <!-- Idle marks an entry the recipe has but the container doesn't yet, readable even without color. -->
                <template #lead="{ mark }">
                    <BrandMark
                        :size="mark"
                        :name="item.name"
                        :logo="environmentVisual(item).logo"
                        :icon="environmentVisual(item).icon"
                        :idle="item.state !== `active`"
                    />
                </template>
                <!-- Name, versions and sentence share one line: versions ride the name they version, the sentence takes what's left and truncates. -->
                <template #title>
                    <!--
                        Clips the whole line so nothing overflows into the trailing facts: the name never yields, versions truncate past half the
                        line, the sentence yields first.
                    -->
                    <span class="flex min-w-0 items-center gap-3 overflow-hidden">
                        <span class="shrink-0">{{ item.name }}</span>
                        <!--
                            Mono against the name's sans; truncates past half the row rather than clipping, since a clipped version number (`24.18`
                            for `24.18.0`) reads as a complete, different one.
                        -->
                        <span v-if="item.tools.length > 0" class="min-w-0 max-w-[50%] shrink-0 truncate font-mono text-2xs font-normal tabular-nums">
                            <span v-for="tool in shownTools(item)" :key="tool.name" v-tooltip.bottom="provenance(tool)" class="mr-3 last:mr-0">
                                <span v-if="toolLabel(item, tool) !== ``" class="text-muted">{{ toolLabel(item, tool) }}&nbsp;</span>
                                <span v-if="tool.version !== undefined" class="text-subtle">{{ tool.version }}</span>
                                <span v-else-if="toolLabel(item, tool) === ``" class="text-subtle">installed</span>
                            </span>
                            <span
                                v-if="item.tools.length > SHOWN_TOOLS"
                                v-tooltip.bottom="item.tools.map((tool) => tool.name).join(`, `)"
                                class="text-subtle"
                            >
                                +{{ item.tools.length - SHOWN_TOOLS }} more
                            </span>
                        </span>
                        <!-- Hides once open: the same sentence is the paragraph's own opening line just below it. -->
                        <span
                            v-if="item.purpose !== undefined && !open.has(item.id)"
                            v-tooltip.bottom.overflow="item.purpose"
                            class="hidden min-w-0 truncate text-2xs font-normal text-muted sm:block"
                        >
                            {{ item.purpose }}
                        </span>
                    </span>
                </template>
                <!-- Only what's worth interrupting for: an attribution that isn't already obvious, and any non-default state. -->
                <template #meta>
                    <span v-if="attribution(item) !== undefined" class="hidden shrink-0 sm:inline">{{ attribution(item) }}</span>
                    <span v-if="stateOf(item) !== undefined" :class="stateOf(item)?.tone" class="inline-flex items-center gap-1 font-medium">
                        <Icon :name="stateOf(item)!.icon" />{{ stateOf(item)!.label }}
                    </span>
                </template>
                <!-- The slot itself must be conditional, not just its contents, or every closed row still gets the gap above it. -->
                <template #below>
                    <!--
                        No `@click.stop` needed: the disclosure's hit area is the header button, a sibling of this block, so nested clicks can't
                        bubble up to it.
                    -->
                    <div class="flex flex-col gap-3">
                        <!-- Rendered as prose, not code: it was written to be read. -->
                        <p class="whitespace-pre-line text-xs leading-relaxed text-muted">
                            {{ full.has(item.id) ? explanation(item) : opening(item) }}
                        </p>
                        <button
                            v-if="rest(item) !== ``"
                            type="button"
                            :class="ui.linkButton(`gap-1 text-2xs text-muted hover:text-content`)"
                            @click="toggleFull(item.id)"
                        >
                            {{ full.has(item.id) ? `Show less` : `Show more` }}
                            <Icon :name="full.has(item.id) ? `chevron-up` : `chevron-down`" />
                        </button>
                        <!-- The plumbing count lives here, not the row: it's the least useful fact and was crowding the row's own line. -->
                        <p v-if="item.extras !== undefined" class="text-2xs text-subtle">
                            Plus {{ item.extras }} libraries and headers these commands need, which nobody runs directly.
                        </p>
                        <!-- Clamped: a toolchain's install step can run to many lines and would push the next row off screen. -->
                        <Code v-if="item.commands !== undefined" :code="item.commands" lang="docker" label="What this installs" :clamp-lines="10" />
                    </div>
                </template>
            </DisclosureRow>
        </RowGroup>

        <!-- The staples as a strip: many names and versions in a few lines instead of one row each. -->
        <RowGroup v-if="staples !== undefined" flat :label="staples.label" :count="countLabel(staples)">
            <!--
                Strip and sentence share one child so the group's divider doesn't fall between a pill and its own sentence; aligned via the group's
                own tier, not repeated padding.
            -->
            <RowNote variant="block">
                <div class="flex flex-col gap-2">
                    <div class="flex flex-wrap gap-1.5">
                        <!--
                            The one filled capsule on the tab, meaning 'click me'; tinted rather than outlined so it steps off the surface instead of
                            framing a hole in it.
                        -->
                        <button
                            v-for="item in staples.items"
                            :key="item.id"
                            type="button"
                            :disabled="item.purpose === undefined"
                            class="ui-chip py-1 pl-1 pr-2.5"
                            :class="picked === item.id ? `ui-chip-on` : ``"
                            @click="pick(item.id)"
                        >
                            <BrandMark :size="18" :name="item.name" :logo="environmentVisual(item).logo" :icon="environmentVisual(item).icon" />
                            <span class="font-medium">{{ item.name }}</span>
                            <span
                                v-if="item.tools[0]?.version !== undefined"
                                v-tooltip.bottom="provenance(item.tools[0])"
                                class="font-mono tabular-nums text-subtle"
                            >
                                {{ item.tools[0].version }}
                            </span>
                        </button>
                    </div>
                    <!-- Under the strip, not beside the pill, so opening one never reflows the grid above it. -->
                    <p v-if="pickedItem !== undefined" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ pickedItem.name }}</span
                        >: {{ pickedItem.purpose }}
                    </p>
                </div>
            </RowNote>
        </RowGroup>

        <!--
            The loading state is drawn as the real shape (labelled sections then the staples strip), not a spinner, since this read is the slowest in
            the hub and its shape is highly predictable.
        -->
        <div v-if="loading && outline" class="flex flex-col gap-5" role="status" aria-busy="true">
            <span class="sr-only">Checking installed versions…</span>
            <!-- Two sections, not three: a sandbox may have no capability group, and an extra one would over-promise height. -->
            <RowGroup v-for="(section, index) in [4, 3]" :key="index" flat undivided>
                <template #label><span class="skeleton block h-2.5" :class="index === 0 ? `w-44` : `w-36`" aria-hidden="true" /></template>
                <SkeletonRows :rows="section" />
            </RowGroup>
            <!-- The staples strip skeleton: pill shapes, not row shapes, so it reads as a different shape at a glance. -->
            <RowGroup flat>
                <template #label><span class="skeleton block h-2.5 w-28" aria-hidden="true" /></template>
                <RowNote variant="block">
                    <div class="flex flex-wrap gap-1.5" aria-hidden="true">
                        <span
                            v-for="(width, index) in [`w-24`, `w-20`, `w-28`, `w-16`, `w-24`, `w-20`, `w-32`, `w-20`]"
                            :key="index"
                            class="skeleton block h-6 rounded-full"
                            :class="width"
                        />
                    </div>
                </RowNote>
            </RowGroup>
        </div>
        <!-- Nothing drawn during the brief pre-outline delay; `loading` still decides which of the four states this is. -->
        <template v-else-if="loading" />
        <Notice v-else-if="error !== undefined" :of="{ tone: `warning`, title: `Could not read what the sandbox has installed.`, detail: error }" />
        <div v-else-if="groups.length === 0" :class="ui.emptyState(`py-8`)">
            Nothing added on top of the stock image yet, and nothing in it answered, which usually means the sandbox is still starting.
        </div>
    </div>
</template>
