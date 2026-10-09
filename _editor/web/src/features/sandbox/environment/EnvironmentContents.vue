<script setup lang="ts">
import type { EnvironmentItem } from "@intentic/sandbox-contract";
import {
    BrandMark,
    Button,
    Code,
    DisclosureRow,
    Notice,
    RowGroup,
    RowNote,
    SkeletonRows,
    SkeletonSnapshot,
    type Tip,
    ui,
    vSkeletonSource,
} from "@intentic/ui";
import { computed, ref } from "vue";
import type { ContentsGroup } from "./useEnvironmentContents";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { environmentVisual } from "./environmentVisual";
import { useT } from "@intentic/ui/i18n";

// What this sandbox has, not its build recipe (one pill away). Decisions (agent-added, capability) get full rows; the
// base staples are a scannable strip, since nobody reads them, they only check for one. One line per row: name,
// versions and a truncated sentence; the full paragraph opens on click, never duplicating the row's own summary.

const t = useT();

const {
    groups,
    loading,
    error,
    removable = false,
    busy = false,
} = defineProps<{
    groups: ContentsGroup[];
    loading: boolean;
    error?: string;
    // Whether the reader may take an agent-asked block out: the card's owner gate, not this list's.
    removable?: boolean;
    // A decision elsewhere on the card is on its way, so none is started here meanwhile.
    busy?: boolean;
}>();
// Asks the card to take one block out; the card confirms it, naming the tool, before anything is posted.
const emit = defineEmits<{ remove: [item: EnvironmentItem] }>();

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
const provenance = (tool: EnvironmentItem[`tools`][number]): Tip => ({
    title: t(`sandbox.environmentContents.liveVersion`),
    rows: [{ label: t(`sandbox.environmentContents.readFrom`), value: tool.name }],
});

// No badge for `active`: it's the normal case, and marking it would drown the two states that matter.
const STATES = computed(
    () =>
        ({
            active: undefined,
            "after-rebuild": { icon: `clock`, label: t(`sandbox.environmentContents.arrivesAfterRebuild`), tone: `text-warning` },
            "awaiting-approval": { icon: `sparkles`, label: t(`sandbox.environmentContents.waitingApproval`), tone: `text-link` },
        }) as const,
);
const stateOf = (item: EnvironmentItem) => STATES.value[item.state];

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
// Only a row the sandbox names a block for is the owner's to take out: a capability's cost goes with its capability, and
// a sandbox too old to remove one names none.
const canRemove = (item: EnvironmentItem): boolean => removable && item.block !== undefined;
// True whenever there is anything beyond the row's own line: detail, commands, a plumbing extras count, or Remove.
const expandable = (item: EnvironmentItem): boolean =>
    item.detail !== undefined || item.commands !== undefined || item.extras !== undefined || canRemove(item);
</script>

<template>
    <!-- Section spacing matches the hub pages, including the outline while the inventory loads. -->
    <!-- `@container`: what fits on a row is a fact about this list's width, and the hub's body is a pane the docked chat can leave far narrower than the window. -->
    <div class="@container flex flex-col gap-6">
        <!-- One element, so its imprint is every section at once; spaced as the column it sits in. Only drawn with
             something in it, or an empty box would add a gap of its own. -->
        <div v-if="groups.length > 0" v-skeleton-source="`sandbox.environment.contents`" class="flex flex-col gap-6">
            <!-- `flat`: this list already sits inside the Environment group's own frame. -->
            <RowGroup v-for="group in rowGroups" :key="group.origin" flat undivided :label="group.label">
                <!-- Expandable rows keep their disclosure control in the lead slot. -->

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
                        <BrandMark plain
                            :size="mark"
                            :name="item.name"
                            :logo="environmentVisual(item).logo"
                            :icon="environmentVisual(item).icon"
                            :idle="item.state !== `active`"
                        />
                    </template>
                    <!-- Names, versions, and purpose share one title line. -->
                    <template #title>
                        <!-- The title line clips overflow while keeping the name visible. -->
                        <span class="flex min-w-0 items-center gap-3 overflow-hidden">
                            <span class="shrink-0">{{ item.name }}</span>
                            <!-- Versions use monospace and occupy at most half the row. -->
                            <span
                                v-if="item.tools.length > 0"
                                class="min-w-0 max-w-[50%] shrink-0 truncate font-mono text-2xs font-normal tabular-nums"
                            >
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
                                class="hidden min-w-0 truncate text-2xs font-normal text-muted @xl:block"
                            >
                                {{ item.purpose }}
                            </span>
                        </span>
                    </template>
                    <!-- Only what's worth interrupting for: an attribution that isn't already obvious, and any non-default state. -->
                    <template #meta>
                        <span v-if="attribution(item) !== undefined" class="hidden shrink-0 @md:inline">{{ attribution(item) }}</span>
                        <span v-if="stateOf(item) !== undefined" :class="stateOf(item)?.tone" class="inline-flex items-center gap-1 font-medium">
                            <Icon :name="stateOf(item)!.icon" />{{ stateOf(item)!.label }}
                        </span>
                    </template>
                    <!-- The slot itself must be conditional, not just its contents, or every closed row still gets the gap above it. -->
                    <template #below>
                        <!-- The disclosure header owns the hit area; the expanded body has no nested toggle. -->
                        <div class="flex flex-col gap-3">
                            <!-- Rendered as prose, not code: it was written to be read. -->
                            <p class="whitespace-pre-line text-xs leading-relaxed text-muted">
                                {{ full.has(item.id) ? explanation(item) : opening(item) }}
                            </p>
                            <button
                                v-if="rest(item) !== ``"
                                type="button"
                                :class="ui.textButton({ size: `xs`, tone: `quiet` })"
                                @click="toggleFull(item.id)"
                            >
                                {{ full.has(item.id) ? t(`ui.action.showLess`) : t(`sandbox.environmentContents.showMore`) }}
                                <Icon :name="full.has(item.id) ? `chevron-up` : `chevron-down`" />
                            </button>
                            <!-- The plumbing count lives here, not the row: it's the least useful fact and was crowding the row's own line. -->
                            <p v-if="item.extras !== undefined" class="text-2xs text-subtle">
                                {{ t(`sandbox.environmentContents.plusLibrariesHeadersCommands`, { extras: item.extras }) }}
                            </p>
                            <!-- Clamped: a toolchain's install step can run to many lines and would push the next row off screen. -->
                            <Code
                                v-if="item.commands !== undefined"
                                :code="item.commands"
                                lang="docker"
                                :label="t(`sandbox.environmentContents.whatInstalls`)"
                                :clamp-lines="10"
                            />
                            <!-- Inside the opened row, under what it installs: taking a tool out is read about before it is pressed. -->
                            <Button
                                v-if="canRemove(item)"
                                :label="t(`sandbox.environmentContents.removeFromEnvironment`)"
                                size="small"
                                tier="quiet"
                                tone="danger"
                                :disabled="busy"
                                class="self-start"
                                @click="emit(`remove`, item)"
                            >
                                <template #icon><Icon name="trash" /></template>
                            </Button>
                        </div>
                    </template>
                </DisclosureRow>
            </RowGroup>

            <!-- The staples as a strip: many names and versions in a few lines instead of one row each. -->
            <RowGroup v-if="staples !== undefined" flat :label="staples.label">
                <!-- The strip and its description stay within one group note. -->
                <RowNote variant="block">
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap gap-1.5">
                            <!-- The active staple is the tab's sole filled capsule. -->
                            <button
                                v-for="item in staples.items"
                                :key="item.id"
                                type="button"
                                :disabled="item.purpose === undefined"
                                :class="ui.chip({ on: picked === item.id }, `py-1 pl-1 pr-2.5`)"
                                @click="pick(item.id)"
                            >
                                <BrandMark plain :size="18" :name="item.name" :logo="environmentVisual(item).logo" :icon="environmentVisual(item).icon" />
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
        </div>

        <!-- Loading draws the sections as they last looked in this sandbox; until then, a mirror of the loaded sections and staples strip. -->
        <SkeletonSnapshot
            v-if="loading && outline"
            of="sandbox.environment.contents"
            :label="t(`sandbox.environmentContents.checkingInstalledVersions`)"
        >
            <div class="flex flex-col gap-6" role="status" aria-busy="true">
                <span class="sr-only">{{ t(`sandbox.environmentContents.checkingInstalledVersions`) }}</span>
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
        </SkeletonSnapshot>
        <!-- Nothing drawn during the brief pre-outline delay; `loading` still decides which of the four states this is. -->
        <template v-else-if="loading" />
        <Notice v-else-if="error !== undefined" :of="{ tone: `warning`, title: t(`sandbox.environmentContents.couldNotRead`), detail: error }" />
        <div v-else-if="groups.length === 0" v-skeleton-source="`sandbox.environment.contents`" :class="ui.emptyState(`py-8`)">
            {{ t(`sandbox.environmentContents.nothingAddedOnTop`) }}
        </div>
    </div>
</template>
