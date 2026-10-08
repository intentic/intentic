<!-- The scope chip's list: the shared tree first, then every conversation's copy under the board's own lanes, each row saying what that conversation is doing, how much it changed and when it last worked, so two copies with the same title can be told apart. Each lane folds to its latest few; typing reaches every copy. -->
<script setup lang="ts">
import { DiffStat, Icon, SearchBar, ui, useListNavigation } from "@intentic/ui";
import { formatDayMonth, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onMounted, ref, useId } from "vue";
import { RouterLink } from "vue-router";
import { agentDisplayTitle, agentStandingMeta, type FleetLane } from "../../agents/fleet/agentStatus";
import { sandboxNow } from "../../agents/fleet/sandboxClock";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { useAgents } from "../../agents/fleet/useAgents";
import { copyMatches, scopeGroups, switchableCopies } from "./scopeChoices";

const t = useT();

const { current, autofocus = false } = defineProps<{
    /** The conversation whose copy is on screen; undefined is the shared tree. */
    current: string | undefined;
    /** Desktop focuses the search on open; a phone's sheet must not summon the soft keyboard. */
    autofocus?: boolean;
}>();
const emit = defineEmits<{ pick: [agent: string | undefined]; close: [] }>();

const { fleet, agentById } = useAgents();

const query = ref(``);
// Lanes the reader has opened past their fold, for as long as the list stays open.
const unfolded = ref<ReadonlySet<FleetLane>>(new Set());
// Read once per opening: a list open for a few seconds does not need its ages ticking.
const now = sandboxNow();

// The copy on screen stays offered even once it has left the live roster (archived with its checkout kept), so the list
// always says where the reader is.
const copies = computed(() => {
    const live = switchableCopies(fleet.value);
    const shown = current === undefined || live.some((agent) => agent.id === current) ? undefined : agentById(current);
    return shown?.branch === undefined ? live : [...live, shown];
});

const WEEK_MS = 7 * 24 * 60 * 60_000;
// Within the week as an age ("3h ago", "2d ago"); past it the day, since "40d ago" is a sum the reader has to do.
const ageOf = (at: number): string => (now - at < WEEK_MS ? timeAgo(at, { now, days: true }) : formatDayMonth(at));

// Each row as drawn: the board's glyph for what it is doing, the name, how much it changed, how long since it worked.
interface CopyRow {
    readonly agent: FleetAgent;
    readonly title: string;
    readonly standing: ReturnType<typeof agentStandingMeta>;
    readonly diff: FleetAgent["diff"];
    readonly age: string;
}
const LANE_LABEL = {
    attention: `shared.attention`,
    active: `shared.active`,
    finished: `shared.finished`,
} as const satisfies Record<FleetLane, string>;

const groups = computed(() =>
    scopeGroups(copies.value, { current, query: query.value, unfolded: unfolded.value }).map((group) => ({
        lane: group.lane,
        label: t(LANE_LABEL[group.lane]),
        total: group.agents.length + group.hidden,
        hidden: group.hidden,
        rows: group.agents.map((agent): CopyRow => ({
            agent,
            title: agentDisplayTitle(agent),
            standing: agentStandingMeta(agent),
            diff: (agent.diff?.files ?? 0) > 0 ? agent.diff : undefined,
            age: ageOf(agent.updatedAt),
        })),
    })),
);

const sharedLabel = computed(() => t(`workspace.workspaceScopeChip.sharedWorkspace`));
// While searching, the shared row only answers a query for it, or Enter after typing a copy's name would go home.
const sharedShown = computed(() => query.value.trim() === `` || copyMatches({ title: sharedLabel.value }, query.value));

const SHARED = `\u0000shared`;
interface Row {
    readonly key: string;
    readonly agent: FleetAgent | undefined;
}
const rows = computed<readonly Row[]>(() => [
    ...(sharedShown.value ? [{ key: SHARED, agent: undefined }] : []),
    ...groups.value.flatMap((group) => group.rows.map((row): Row => ({ key: row.agent.id, agent: row.agent }))),
]);
const indexOf = computed(() => new Map(rows.value.map((row, index) => [row.key, index])));
const { activeIndex, activeRow, move, setRowEl } = useListNavigation(rows, (row) => row.key);

const listId = `scope-${useId()}`;
const optionId = (key: string): string => `${listId}-${indexOf.value.get(key) ?? 0}`;

const pick = (row: Row | undefined): void => {
    if (row !== undefined) {
        emit(`pick`, row.agent?.id);
    }
};

const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
        event.preventDefault();
        move(event.key === `ArrowDown` ? 1 : -1);
        return;
    }
    if (event.key === `Enter` && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        pick(activeRow.value);
        return;
    }
    // A query is cleared before the list closes, the way every filter field here answers Escape.
    if (event.key === `Escape` && query.value !== ``) {
        event.stopPropagation();
        query.value = ``;
    }
};

const search = ref<{ focus: () => void } | null>(null);

// The pressed row goes with the fold, so the keyboard goes back to the search rather than out of the list.
const unfold = (lane: FleetLane): void => {
    unfolded.value = new Set([...unfolded.value, lane]);
    if (autofocus) {
        search.value?.focus();
    }
};

onMounted(() => {
    // Opens on the copy on screen, not the top: the highlight is the list's answer to "which one is this".
    activeIndex.value = indexOf.value.get(current ?? SHARED) ?? 0;
    void nextTick(() => {
        move(0);
        if (autofocus) {
            search.value?.focus();
        }
    });
});
</script>

<template>
    <div class="flex min-h-0 min-w-0 flex-col" @keydown="onKeydown">
        <SearchBar
            ref="search"
            v-model="query"
            :placeholder="t(`workspace.workspaceScopeChip.findCopy`)"
            :aria-label="t(`workspace.workspaceScopeChip.findCopy`)"
            :aria-controls="listId"
            :aria-activedescendant="activeRow === undefined ? undefined : optionId(activeRow.key)"
        />
        <div
            :id="listId"
            role="listbox"
            :aria-label="t(`workspace.workspaceScopeChip.showFilesFrom`)"
            tabindex="-1"
            class="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 focus:outline-none md:max-h-[min(28rem,60vh)]"
        >
            <button
                v-if="sharedShown"
                :id="optionId(SHARED)"
                :ref="(el) => setRowEl(SHARED, el)"
                type="button"
                role="option"
                :aria-selected="current === undefined"
                class="ui-row-select ui-off flex w-full items-center gap-2.5 px-3 py-1.5 text-left max-md:min-h-12"
                :class="{ 'ui-row-select-on': activeIndex === indexOf.get(SHARED) }"
                @click="emit(`pick`, undefined)"
                @mouseenter="activeIndex = indexOf.get(SHARED) ?? 0"
            >
                <Icon
                    name="folder"
                    class="w-4 shrink-0 text-sm"
                    :class="current === undefined ? `text-primary-500` : `text-muted`"
                    aria-hidden="true"
                />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm font-medium md:text-xs" :class="current === undefined ? `text-link` : `text-content`">{{
                        sharedLabel
                    }}</span>
                    <span class="truncate text-2xs text-subtle">{{ t(`workspace.workspaceScopeChip.sharedHint`) }}</span>
                </span>
                <Icon
                    name="check"
                    class="w-3 shrink-0 text-2xs text-primary-500"
                    :class="current === undefined ? `` : `invisible`"
                    aria-hidden="true"
                />
            </button>

            <template v-for="group in groups" :key="group.lane">
                <p
                    role="presentation"
                    class="flex items-baseline justify-between gap-2 px-3 pb-1 pt-3 text-2xs font-medium uppercase tracking-wide text-subtle"
                >
                    <span>{{ group.label }}</span>
                    <span class="tabular-nums">{{ group.total }}</span>
                </p>
                <button
                    v-for="row in group.rows"
                    :id="optionId(row.agent.id)"
                    :key="row.agent.id"
                    :ref="(el) => setRowEl(row.agent.id, el)"
                    type="button"
                    role="option"
                    :aria-selected="row.agent.id === current"
                    class="ui-row-select ui-off flex w-full items-center gap-2.5 px-3 py-1.5 text-left max-md:min-h-11"
                    :class="{ 'ui-row-select-on': activeIndex === indexOf.get(row.agent.id) }"
                    @click="emit(`pick`, row.agent.id)"
                    @mouseenter="activeIndex = indexOf.get(row.agent.id) ?? 0"
                >
                    <!-- What the conversation is doing, in the board's own glyph: the one thing that tells forty rows apart at a glance. -->
                    <Icon
                        :name="row.standing.icon"
                        :spin="row.standing.spin === true"
                        class="w-4 shrink-0 text-xs"
                        :class="row.standing.class"
                        v-tooltip.left="row.standing.label"
                    />
                    <span class="sr-only">{{ row.standing.label }}</span>
                    <span
                        class="min-w-0 flex-1 truncate text-sm md:text-xs"
                        :class="row.agent.id === current ? `font-medium text-link` : `text-content`"
                        v-tooltip.bottom.overflow="row.title"
                        >{{ row.title }}</span
                    >
                    <DiffStat v-if="row.diff !== undefined" :additions="row.diff.insertions" :deletions="row.diff.deletions" />
                    <span class="min-w-11 shrink-0 text-right text-2xs tabular-nums text-subtle">{{ row.age }}</span>
                    <Icon
                        name="check"
                        class="w-3 shrink-0 text-2xs text-primary-500"
                        :class="row.agent.id === current ? `` : `invisible`"
                        aria-hidden="true"
                    />
                </button>
                <button
                    v-if="group.hidden > 0"
                    type="button"
                    :class="ui.textButton({ tone: `link`, size: `xs` }, `my-0 min-h-8 w-full px-3 pl-[2.375rem] max-md:min-h-11`)"
                    @click="unfold(group.lane)"
                >
                    {{ t(`workspace.workspaceScopeChip.showMore`, { count: group.hidden }, group.hidden) }}
                </button>
            </template>

            <p v-if="rows.length === 0" class="px-3 py-4 text-center text-2xs text-subtle">
                {{ t(`workspace.workspaceScopeChip.noCopyMatches`) }}
            </p>
        </div>
        <!-- Outside the scroll, so it stays in reach however long the list runs. -->
        <div v-if="current !== undefined" class="flex shrink-0 items-center border-t border-line px-3 py-1">
            <RouterLink :to="`/agents/${current}`" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `my-0 min-h-8`)" @click="emit(`close`)">
                <Icon name="check-square" aria-hidden="true" />
                {{ t(`workspace.words.seeChanges`) }}
            </RouterLink>
        </div>
    </div>
</template>
