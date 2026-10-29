<!-- The scope chip's list, and the composer's "Start from": the shared workspace (its main line) first, then each repository's other branches, then every conversation's copy under the board's own lanes, each row saying what that conversation is doing, how much it changed and when it last worked, so two copies with the same title can be told apart. Each lane and each repository folds to its latest few; typing reaches every row. -->
<script setup lang="ts">
import { DiffStat, Icon, SearchBar, SectionHeader, ui, useListNavigation } from "@intentic/ui";
import { formatDayMonth, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onMounted, ref, useId, watch } from "vue";
import { RouterLink } from "vue-router";
import { agentScope, branchScope, isShared, SHARED_SCOPE, sameScope, scopeKey, type ViewScope } from "../../../app/workspaceScope";
import type { FleetLane } from "../../../models/agent-status/agentStatus-lanes";
import { agentDisplayTitle, agentStandingMeta } from "../../../models/agent-status/agentStatus-meta";
import { sandboxNow } from "../../../models/agent-status/sandboxClock";
import { canStartFresh } from "../../../models/fleet/freshSession";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";
import { useAgents } from "../../../models/fleet/useAgents";
import { branchGroups, copyMatches, scopeGroups, switchableCopies } from "./scopeChoices";
import { useBranchChoices } from "./useBranchChoices";

const t = useT();

const {
    current,
    autofocus = false,
    purpose = `view`,
    mainLine,
} = defineProps<{
    /** The copy on screen (or the start chosen): the shared tree, a conversation's copy, or a branch. */
    current: ViewScope;
    /** Desktop focuses the search on open; a phone's sheet must not summon the soft keyboard. */
    autofocus?: boolean;
    /** What a pick is for: looking at a copy in the Workspace, or a new agent starting from it. */
    purpose?: `view` | `start`;
    /** The shared workspace's own branch, said on its row. */
    mainLine?: string | undefined;
}>();
const emit = defineEmits<{ pick: [scope: ViewScope]; close: [] }>();

const { fleet, agentById } = useAgents();
const { choices: branches } = useBranchChoices();

const query = ref(``);
// Lanes and repositories the reader has opened past their fold, for as long as the list stays open.
const unfolded = ref<ReadonlySet<FleetLane>>(new Set());
const unfoldedRepos = ref<ReadonlySet<string>>(new Set());
// Read once per opening: a list open for a few seconds does not need its ages ticking.
const now = sandboxNow();

const currentAgent = computed(() => current.agent);
// What can be looked at, or started from: a new agent starts from a copy only where a fresh session on it can be cut.
const offered = (fleetNow: readonly FleetAgent[]): FleetAgent[] =>
    purpose === `start` ? fleetNow.filter((agent) => canStartFresh(agent, `ask`)) : switchableCopies(fleetNow);
// The copy on screen stays offered even once it has left the live roster (archived with its checkout kept), so the list
// always says where the reader is.
const copies = computed(() => {
    const live = offered(fleet.value);
    const id = currentAgent.value;
    const shown = id === undefined || live.some((agent) => agent.id === id) ? undefined : agentById(id);
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
    scopeGroups(copies.value, { current: currentAgent.value, query: query.value, unfolded: unfolded.value }).map((group) => ({
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

// One heading per repository once there are several; a lone repository's is just "Branches".
const branchSections = computed(() => {
    const listed = branchGroups(branches.value, { current: current.branch === undefined ? undefined : current, query: query.value, unfolded: unfoldedRepos.value });
    const several = new Set(branches.value.map((choice) => choice.repo)).size > 1;
    return listed.map((group) => ({
        repo: group.repo,
        label: several
            ? t(`workspace.workspaceScopeChip.branchesIn`, { repo: group.repo === `root` ? t(`sandbox.repoCheckRow.thisWorkspace`) : group.repo })
            : t(`workspace.workspaceScopeChip.branches`),
        total: group.branches.length + group.hidden,
        hidden: group.hidden,
        rows: group.branches.map((choice) => ({ ...choice, scope: branchScope(choice), age: ageOf(choice.at) })),
    }));
});

const sharedLabel = computed(() => (purpose === `start` ? t(`workspace.workspaceScopeChip.mainLine`) : t(`workspace.workspaceScopeChip.sharedWorkspace`)));
const sharedHint = computed(() => {
    const hint = purpose === `start` ? t(`workspace.workspaceScopeChip.startHint`) : t(`workspace.workspaceScopeChip.sharedHint`);
    return mainLine === undefined ? hint : `${mainLine} · ${hint}`;
});
// While searching, the shared row only answers a query for it, or Enter after typing a copy's name would go home.
const sharedShown = computed(() => query.value.trim() === `` || copyMatches({ title: `${sharedLabel.value} ${mainLine ?? ``}` }, query.value));

const SHARED = `\u0000shared`;
const keyOf = (scope: ViewScope): string => (isShared(scope) ? SHARED : scopeKey(scope));
interface Row {
    readonly key: string;
    readonly scope: ViewScope;
}
const rows = computed<readonly Row[]>(() => [
    ...(sharedShown.value ? [{ key: SHARED, scope: SHARED_SCOPE }] : []),
    ...branchSections.value.flatMap((section) => section.rows.map((row): Row => ({ key: keyOf(row.scope), scope: row.scope }))),
    ...groups.value.flatMap((group) => group.rows.map((row): Row => ({ key: keyOf(agentScope(row.agent.id)), scope: agentScope(row.agent.id) }))),
]);
const indexOf = computed(() => new Map(rows.value.map((row, index) => [row.key, index])));
const { activeIndex, activeRow, move, setRowEl } = useListNavigation(rows, (row) => row.key);

const listId = `scope-${useId()}`;
const optionId = (key: string): string => `${listId}-${indexOf.value.get(key) ?? 0}`;
const on = (scope: ViewScope): boolean => sameScope(scope, current);
const activeOn = (key: string): boolean => activeIndex.value === indexOf.value.get(key);
const hover = (key: string): void => {
    activeIndex.value = indexOf.value.get(key) ?? 0;
};

const pick = (row: Row | undefined): void => {
    if (row !== undefined) {
        emit(`pick`, row.scope);
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
const refocus = (): void => {
    if (autofocus) {
        search.value?.focus();
    }
};
const unfold = (lane: FleetLane): void => {
    unfolded.value = new Set([...unfolded.value, lane]);
    refocus();
};
const unfoldRepo = (repo: string): void => {
    unfoldedRepos.value = new Set([...unfoldedRepos.value, repo]);
    refocus();
};

// A branch on screen is listed only once the repositories' branches are read, after the list opened: the highlight
// moves to it then, unless the reader has started typing.
watch(
    () => indexOf.value.get(keyOf(current)),
    (index, before) => {
        if (index !== undefined && before === undefined && query.value === ``) {
            activeIndex.value = index;
        }
    },
);

onMounted(() => {
    // Opens on the copy on screen, not the top: the highlight is the list's answer to "which one is this".
    activeIndex.value = indexOf.value.get(keyOf(current)) ?? 0;
    void nextTick(() => {
        move(0);
        refocus();
    });
});

const ROW = `ui-row-select ui-off flex w-full items-center gap-2.5 px-3 py-1.5 text-left`;
const MORE = ui.textButton({ tone: `link`, size: `xs`, flush: true }, `min-h-8 w-full px-3 pl-[2.375rem] max-md:min-h-11`);
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
            :aria-label="purpose === `start` ? t(`workspace.workspaceScopeChip.startFrom`) : t(`workspace.workspaceScopeChip.showFilesFrom`)"
            tabindex="-1"
            class="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 focus:outline-none md:max-h-[min(28rem,60vh)]"
        >
            <button
                v-if="sharedShown"
                :id="optionId(SHARED)"
                :ref="(el) => setRowEl(SHARED, el)"
                type="button"
                role="option"
                :aria-selected="on(SHARED_SCOPE)"
                :class="[ROW, `max-md:min-h-12`, { 'ui-row-select-on': activeOn(SHARED) }]"
                @click="emit(`pick`, SHARED_SCOPE)"
                @mouseenter="hover(SHARED)"
            >
                <Icon name="folder" class="w-4 shrink-0 text-sm" :class="on(SHARED_SCOPE) ? `text-accent` : `text-muted`" aria-hidden="true" />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm font-medium md:text-xs" :class="on(SHARED_SCOPE) ? `text-link` : `text-content`">{{ sharedLabel }}</span>
                    <span class="truncate text-2xs text-subtle">{{ sharedHint }}</span>
                </span>
                <Icon name="check" class="w-3 shrink-0 text-2xs text-accent" :class="on(SHARED_SCOPE) ? `` : `invisible`" aria-hidden="true" />
            </button>

            <template v-for="section in branchSections" :key="`branches:${section.repo}`">
                <SectionHeader :label="section.label" density="dense" class="px-3 pb-1 pt-3" role="presentation">
                    <template #info>
                        <span class="text-2xs tabular-nums text-subtle">{{ section.total }}</span>
                    </template>
                </SectionHeader>
                <button
                    v-for="row in section.rows"
                    :id="optionId(keyOf(row.scope))"
                    :key="keyOf(row.scope)"
                    :ref="(el) => setRowEl(keyOf(row.scope), el)"
                    type="button"
                    role="option"
                    :aria-selected="on(row.scope)"
                    :class="[ROW, `max-md:min-h-11`, { 'ui-row-select-on': activeOn(keyOf(row.scope)) }]"
                    @click="emit(`pick`, row.scope)"
                    @mouseenter="hover(keyOf(row.scope))"
                >
                    <Icon name="git-branch" class="w-4 shrink-0 text-xs text-muted" aria-hidden="true" />
                    <span
                        class="min-w-0 flex-1 truncate font-mono text-sm md:text-xs"
                        :class="on(row.scope) ? `font-medium text-link` : `text-content`"
                        v-tooltip.bottom.overflow="row.branch"
                        >{{ row.branch }}</span
                    >
                    <!-- Only on a remote so far: the daemon makes the local branch the first time it is looked at or started from. -->
                    <span v-if="row.remote !== undefined" class="shrink-0 text-2xs text-subtle" v-tooltip.left="t(`workspace.workspaceScopeChip.remoteOnly`)">{{
                        row.remote
                    }}</span>
                    <span class="min-w-11 shrink-0 text-right text-2xs tabular-nums text-subtle">{{ row.age }}</span>
                    <Icon name="check" class="w-3 shrink-0 text-2xs text-accent" :class="on(row.scope) ? `` : `invisible`" aria-hidden="true" />
                </button>
                <button v-if="section.hidden > 0" type="button" :class="MORE" @click="unfoldRepo(section.repo)">
                    {{ t(`workspace.workspaceScopeChip.showMore`, { count: section.hidden }, section.hidden) }}
                </button>
            </template>

            <template v-for="group in groups" :key="group.lane">
                <!-- The total counts the copies folded behind "Show more" too, which the rows under it do not tally. -->
                <SectionHeader :label="group.label" density="dense" class="px-3 pb-1 pt-3" role="presentation">
                    <template #info>
                        <span class="text-2xs tabular-nums text-subtle">{{ group.total }}</span>
                    </template>
                </SectionHeader>
                <button
                    v-for="row in group.rows"
                    :id="optionId(row.agent.id)"
                    :key="row.agent.id"
                    :ref="(el) => setRowEl(keyOf(agentScope(row.agent.id)), el)"
                    type="button"
                    role="option"
                    :aria-selected="row.agent.id === currentAgent"
                    :class="[ROW, `max-md:min-h-11`, { 'ui-row-select-on': activeOn(keyOf(agentScope(row.agent.id))) }]"
                    @click="emit(`pick`, agentScope(row.agent.id))"
                    @mouseenter="hover(keyOf(agentScope(row.agent.id)))"
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
                        :class="row.agent.id === currentAgent ? `font-medium text-link` : `text-content`"
                        v-tooltip.bottom.overflow="row.title"
                        >{{ row.title }}</span
                    >
                    <DiffStat v-if="row.diff !== undefined" :additions="row.diff.insertions" :deletions="row.diff.deletions" />
                    <span class="min-w-11 shrink-0 text-right text-2xs tabular-nums text-subtle">{{ row.age }}</span>
                    <Icon
                        name="check"
                        class="w-3 shrink-0 text-2xs text-accent"
                        :class="row.agent.id === currentAgent ? `` : `invisible`"
                        aria-hidden="true"
                    />
                </button>
                <button v-if="group.hidden > 0" type="button" :class="MORE" @click="unfold(group.lane)">
                    {{ t(`workspace.workspaceScopeChip.showMore`, { count: group.hidden }, group.hidden) }}
                </button>
            </template>

            <p v-if="rows.length === 0" class="px-3 py-4 text-center text-2xs text-subtle">
                {{ t(`workspace.workspaceScopeChip.noCopyMatches`) }}
            </p>
        </div>
        <!-- Outside the scroll, so it stays in reach however long the list runs: what a look at another copy leaves where it was. -->
        <div v-if="purpose === `view` && !isShared(current)" class="flex shrink-0 flex-col gap-1 border-t border-line px-3 py-1.5">
            <p class="text-2xs text-subtle">{{ t(`workspace.workspaceScopeChip.staysShared`) }}</p>
            <RouterLink
                v-if="currentAgent !== undefined"
                :to="`/agents/${currentAgent}`"
                :class="ui.textButton({ tone: `quiet`, size: `xs`, flush: true }, `min-h-8 self-start`)"
                @click="emit(`close`)"
            >
                <Icon name="check-square" aria-hidden="true" />
                {{ t(`workspace.words.seeChanges`) }}
            </RouterLink>
        </div>
    </div>
</template>
