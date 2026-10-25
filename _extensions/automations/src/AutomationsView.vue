<script setup lang="ts">
import type { AutomationSummary, AutomationTemplate } from "@intentic/sandbox-contract/schemas/automations";
import {
    Await,
    ConfirmDialog,
    Icon,
    Notice,
    noticeOf,
    PageAction,
    RowGroup,
    SearchBar,
    Section,
    SegmentedControl,
    SkeletonRows,
    SplitView,
    ui,
} from "@intentic/extension-ui";
import { computed, nextTick, reactive, ref, watch } from "vue";
import AutomationCalendar from "./calendar/AutomationCalendar.vue";
import AutomationComposer from "./AutomationComposer.vue";
import AutomationEditor from "./AutomationEditor.vue";
import AutomationRail, { type RailShelf } from "./shelves/AutomationRail.vue";
import AutomationRow from "./AutomationRow.vue";
import VisitorChatInstallDialog from "./VisitorChatInstallDialog.vue";
import { host } from "./host";
import { availableTemplates, glyph, useCatalog, withAvailability } from "./catalog";
import { useAutomations } from "./useAutomations";
import { gistOf, isFailing } from "./shelves/grouping";
import { useShelves } from "./shelves/useShelves";
import { t } from "./i18n.js";

// Automations: trigger, then optional guard, then the prompt the agent wakes with; the daemon fires them and records
// history. The page lists what's standing, filed on shelves by what the jobs are for (grouping.ts), and what else could
// be (the offers below). A rail names the shelves once there are two, so fifty automations are a handful of places to
// go rather than one long scroll. Creating and editing happen inline, never in a dialog.
//
// Two lenses on the one list. The List is home: every trigger kind, its state, its controls. The Calendar answers what
// the list cannot, across rows: what wakes when this week, what piles onto the same night, what ran and failed. Only
// clock-driven automations have a place on it, which is why it is a second lens rather than the page.

const { automations, loaded, save, setEnabled, remove, run } = useAutomations();
// A list that never answered says so in its own place; up here, only one whose last answer still stands.
const listError = computed(() => (loaded.value.state === `ready` ? loaded.value.refreshError : undefined));
const { sources, templates, error: catalogError } = useCatalog();
// Resolved once here and handed down, so the row, composer and shelves all read the one answer.
const listenerSources = computed(() => withAvailability(sources.value, host().workspace.capabilities()));
const offered = computed(() => availableTemplates(templates.value, host().workspace.capabilities()));

// Below this count, scanning by eye is instant and the filter bar is just chrome.
const FILTER_FROM = 6;

type View = `all` | `on` | `off` | `failing`;

const createOpen = ref(false);
// List-action errors (toggle/delete/run): the dialog carries its own submit error.
const actionError = ref<string | undefined>(undefined);
// Rows with their detail unfolded.
const expanded = reactive(new Set<string>());
// By id, not object, so it survives the list refetching under it (a save inside the panel does invalidate).
const installId = ref<string | undefined>(undefined);
const installing = computed(() => automations.value.find((automation) => automation.id === installId.value));
// The chore pill mid-create, so its pill alone shows the wait.
const enabling = ref<string | undefined>(undefined);
// Awaiting a confirmed delete: its whole run history goes too, and nothing restores it.
const confirmRemoveId = ref<string | undefined>(undefined);
const search = ref(``);
const view = ref<View>(`all`);

// Which lens, remembered per browser: somebody who plans by the week opens on the week.
type Lens = `list` | `calendar`;
const LENS_KEY = `intentic.automations.lens`;
const readLens = (): Lens => {
    try {
        return localStorage.getItem(LENS_KEY) === `calendar` ? `calendar` : `list`;
    } catch {
        // allow(silent-catch): storage refused (a locked-down browser) is the list, every time.
        return `list`;
    }
};
const lens = ref<Lens>(readLens());
watch(lens, (next) => {
    // An edit the calendar opened belongs to the calendar; the list edits in its rows.
    editingId.value = undefined;
    try {
        localStorage.setItem(LENS_KEY, next);
    } catch {
        // allow(silent-catch): not remembering the lens costs one click next time, nothing more.
    }
});
const lensOptions = computed(() => [
    { label: t(`automationsView.list`), value: `list` as const, icon: `bars` as const },
    { label: t(`automationsView.calendar`), value: `calendar` as const, icon: `calendar` as const },
]);
// A moment clicked on the calendar, which the composer opens on as a one-time wake.
const createAt = ref<number | undefined>(undefined);
// The automation the calendar is editing, in the card above it; the list edits inside its own row instead.
const editingId = ref<string | undefined>(undefined);
const editingAutomation = computed(() => automations.value.find((automation) => automation.id === editingId.value));
// The card the calendar opened, brought into view: the click that opened it may be a screen further down.
const topCard = ref<HTMLElement>();
const revealTop = (): void => void nextTick(() => topCard.value?.scrollIntoView({ block: `nearest`, behavior: `smooth` }));

const topError = computed(() => actionError.value ?? listError.value ?? catalogError.value);

// The shelves, and the one the page stands on: `?shelf=` in the URL, so a shelf is linkable and Back works. The rail
// earns its column only once there are two shelves to choose between; with one, the page is that shelf.
const { shelves, shelfLabelOf } = useShelves(automations);
const railed = computed(() => shelves.value.length > 1);
const shelfParam = computed<string>({
    get: () => host().route.query()[`shelf`] ?? ``,
    set: (value) => host().route.setQuery({ shelf: value === `` ? undefined : value }),
});
// A linked shelf that is gone (its last automation deleted or refiled) falls back to everything.
const activeShelf = computed(() => (railed.value ? shelves.value.find((shelf) => shelf.key === shelfParam.value) : undefined));
const railShelf = computed<string>({ get: () => activeShelf.value?.key ?? ``, set: (value) => (shelfParam.value = value) });
const railShelves = computed<RailShelf[]>(() =>
    shelves.value.map((shelf) => ({ key: shelf.key, label: shelf.label, kind: shelf.kind, total: shelf.automations.length, on: shelf.on, failing: shelf.failing })),
);
const allShelf = computed<RailShelf>(() => ({
    key: ``,
    label: t(`automationRail.all`),
    kind: `all`,
    total: automations.value.length,
    on: automations.value.filter((automation) => automation.enabled).length,
    failing: automations.value.filter(isFailing).length,
}));
// What the page stands on, for the list and the calendar alike: one shelf's automations, or every one.
const inShelf = computed(() => activeShelf.value?.automations ?? automations.value);

const matchesSearch = (automation: AutomationSummary): boolean => {
    const needle = search.value.trim().toLowerCase();
    return (
        needle === `` ||
        [automation.id, automation.note ?? ``, automation.prompt].some((text) => text.toLowerCase().includes(needle))
    );
};
const searched = computed(() => inShelf.value.filter(matchesSearch));
const counts = computed(() => ({
    all: searched.value.length,
    on: searched.value.filter((automation) => automation.enabled).length,
    off: searched.value.filter((automation) => !automation.enabled).length,
    failing: searched.value.filter(isFailing).length,
}));
// The Errors tab appears only once something fails, so its presence is itself the alert; it stays while active so a
// fixed run can't strand the filter.
const viewOptions = computed<{ label: string; value: View; badge: number }[]>(() => [
    { label: t(`automationsView.all`), value: `all`, badge: counts.value.all },
    { label: t(`automationsView.on`), value: `on`, badge: counts.value.on },
    { label: t(`automationsView.off`), value: `off`, badge: counts.value.off },
    ...(counts.value.failing > 0 || view.value === `failing`
        ? [{ label: t(`automationsView.errors`), value: `failing` as const, badge: counts.value.failing }]
        : []),
]);

// Fixed order (enabled, then name), so a row never moves under the cursor when a run lands; the Errors filter finds
// what needs attention instead.
const shown = computed(() =>
    searched.value
        .filter((automation) =>
            view.value === `all` ? true : view.value === `failing` ? isFailing(automation) : automation.enabled === (view.value === `on`),
        )
        .toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id)),
);

// The rows as the page lays them out: one group per shelf, in the shelves' own order, each keeping the fixed row order
// above. A heading only where there is more than one shelf on the page; a picked shelf is named by the rail beside it.
const groups = computed(() => {
    const picked = activeShelf.value;
    return shelves.value
        .filter((shelf) => picked === undefined || shelf.key === picked.key)
        .map((shelf) => {
            const ids = new Set(shelf.automations.map((automation) => automation.id));
            return { key: shelf.key, label: picked === undefined && railed.value ? shelf.label : undefined, rows: shown.value.filter((automation) => ids.has(automation.id)) };
        })
        .filter((group) => group.rows.length > 0);
});
// A chore recipe with no automation of that id yet. Matching on id, not trigger, so a user's own second review chore
// doesn't hide the stock one.
const availableChores = computed(() =>
    offered.value.filter((template) => template.offer === `create` && !automations.value.some((automation) => automation.id === template.id)),
);

// Templates marked `configure` (today just Visitor chat): picking one opens the composer prefilled, not a silent save,
// since an unconfigured Visitor chat would admit nobody.
const availableSuggestions = computed(() =>
    offered.value.filter((template) => template.offer === `configure` && !automations.value.some((automation) => automation.id === template.id)),
);
// Which recipe the composer opens on, when it was opened from a suggestion rather than from "New".
const createPrefill = ref<AutomationTemplate | undefined>(undefined);
const openFromSuggestion = (recipe: AutomationTemplate): void => {
    createPrefill.value = recipe;
    createOpen.value = true;
};
const closeComposer = (): void => {
    createOpen.value = false;
    createPrefill.value = undefined;
    createAt.value = undefined;
};
const createAtSlot = (at: number): void => {
    editingId.value = undefined;
    createPrefill.value = undefined;
    createAt.value = at;
    createOpen.value = true;
    revealTop();
};
const editFromCalendar = (id: string): void => {
    closeComposer();
    editingId.value = id;
    revealTop();
};
const openNew = (): void => {
    editingId.value = undefined;
    createOpen.value = true;
};
// The calendar speaks in ids; the list's own handlers take the row.
const byId = (id: string): AutomationSummary | undefined => automations.value.find((automation) => automation.id === id);
const runById = (id: string): void => {
    const automation = byId(id);
    if (automation !== undefined) {
        void runNow(automation);
    }
};
const toggleById = (id: string, enabled: boolean): void => {
    const automation = byId(id);
    if (automation !== undefined) {
        void toggle(automation, enabled);
    }
};

// Enablement is its own mutation: a switch changes one fact and never serializes the automation around it.
const toggle = async (automation: AutomationSummary, enabled: boolean): Promise<void> => {
    actionError.value = undefined;
    try {
        await setEnabled.mutateAsync({ id: automation.id, enabled });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : t(`automationsView.couldntUpdate`);
    }
};

// Only confirms the fire started; the daemon runs it detached, same as its own cron would, so the outcome shows up
// later in the run history.
const runNow = async (automation: AutomationSummary): Promise<void> => {
    actionError.value = undefined;
    // Open the row, so the run appears where the user is already looking instead of behind a disclosure.
    expanded.add(automation.id);
    try {
        await run.mutateAsync(automation.id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : t(`automationsView.couldntRun`);
    }
};

// A chore opens via the composer, never creates directly: a recipe can't know which providers are connected, so the
// person picks the model instead of it guessing one or creating a row that can't fire.

const removeAutomation = async (): Promise<void> => {
    const id = confirmRemoveId.value;
    if (id === undefined) {
        return;
    }
    actionError.value = undefined;
    try {
        await remove.mutateAsync(id);
        confirmRemoveId.value = undefined;
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : t(`automationsView.couldntRemove`);
    }
};

const toggleDetail = (id: string): void => {
    if (!expanded.delete(id)) {
        expanded.add(id);
    }
};
</script>

<template>
    <SplitView :title="t(`automationsView.automations`)" scroll="page" :scroll-key="railShelf">
        <template #actions>
            <SegmentedControl v-model="lens" :options="lensOptions" />
            <PageAction icon="plus" :label="t(`automationsView.newAutomation`)" primary @click="openNew" />
        </template>

        <template v-if="topError" #strips>
            <Notice :of="noticeOf(topError)" />
        </template>

        <!-- The rail narrows rather than selects, so on a phone it folds above the list instead of covering it. -->
        <template v-if="railed" #rail>
            <AutomationRail v-model="railShelf" :all="allShelf" :shelves="railShelves" />
        </template>

        <template #detail>
            <div class="flex flex-col gap-6">
                <!-- Keyed on the prefill and the slot, so picking a different suggestion or moment while open remounts fresh
                     instead of keeping stale fields. -->
                <div v-if="createOpen" ref="topCard">
                    <AutomationComposer
                        :templates="offered"
                        :key="`${createPrefill?.id ?? `blank`}@${createAt ?? ``}`"
                        :prefill="createPrefill"
                        :at="createAt"
                        :listener-sources="listenerSources"
                        @created="expanded.add($event)"
                        @close="closeComposer"
                    />
                </div>

                <!-- The calendar's edit form, shaped like the composer: the same card, the same place, for the other verb. -->
                <section
                    v-if="lens === `calendar` && editingAutomation"
                    ref="topCard"
                    :key="editingAutomation.id"
                    class="flex flex-col gap-3 rounded-lg bg-card p-4 shadow-sm"
                >
                    <div class="flex items-center gap-2">
                        <Icon name="pencil" class="shrink-0 text-2xs text-subtle" />
                        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-content">{{ editingAutomation.id }}</h2>
                        <button type="button" :class="ui.iconButton()" :aria-label="t(`automationComposer.close`)" @click="editingId = undefined">
                            <Icon name="times" class="text-xs" />
                        </button>
                    </div>
                    <AutomationEditor
                        :automation="editingAutomation"
                        :listener-sources="listenerSources"
                        :templates="offered"
                        @done="editingId = undefined"
                    />
                </section>

                <!-- Skeletons distinguish the pending list from a true empty state. -->
                <Await :of="loaded" imprint="automations.list" :label="t(`automationsView.readingAutomations`)">
                    <template #fallback>
                        <RowGroup role="status" aria-busy="true">
                            <template #label><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></template>
                            <span class="sr-only">{{ t(`automationsView.readingAutomations`) }}</span>
                            <SkeletonRows :rows="3" description control />
                        </RowGroup>
                    </template>

                    <!-- The week of whatever the rail stands on: one shelf's wakes, or every one. -->
                    <AutomationCalendar
                        v-if="lens === `calendar`"
                        :automations="inShelf"
                        :busy="save.isPending.value || setEnabled.isPending.value || run.isPending.value"
                        :draft="createOpen ? createAt : undefined"
                        @create="createAtSlot"
                        @edit="editFromCalendar"
                        @run="runById"
                        @toggle="toggleById"
                        @list="lens = `list`"
                    />

                    <!-- The header names both navigation destinations without adding another button. The second sentence points at the
                         offers section below, which is itself conditional: with nothing on offer here (a workspace whose capabilities
                         match no template) it sent the reader to look for a list that is not on the page. -->
                    <div v-else-if="automations.length === 0" :class="ui.emptyState('flex flex-col items-center gap-1 py-6')">
                        <span class="text-sm text-content">{{ t(`automationsView.nothingRunsOnOwn`) }}</span>
                        <span v-if="availableChores.length > 0 || availableSuggestions.length > 0">
                            {{ t(`automationsView.takeOneOffersBelow`) }} <b class="font-medium text-muted">{{ t(`automationsView.newAutomation`) }}</b
                            >.
                        </span>
                        <span v-else
                            >{{ t(`automationsView.buildOne`) }} <b class="font-medium text-muted">{{ t(`automationsView.newAutomation`) }}</b
                            >.</span
                        >
                    </div>
                    <div v-else class="flex flex-col gap-6">
                        <!-- Filter by words and by state, within the shelf the rail stands on. -->
                        <div v-if="automations.length >= FILTER_FROM" class="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <SearchBar
                                v-model="search"
                                variant="field"
                                clearable
                                :aria-label="t(`automationsView.filterAutomations`)"
                                :placeholder="t(`automationsView.filterByNamePrompt`)"
                                class="min-w-56 max-w-sm flex-1"
                            />
                            <SegmentedControl v-model="view" :options="viewOptions" class="ml-auto" />
                        </div>

                        <div v-if="shown.length === 0" :class="ui.emptyState('py-5')">
                            {{ t(`automationsView.nothingMatchesFilter`) }}
                            <button
                                type="button"
                                class="cursor-pointer text-link hover:underline"
                                @click="
                                    search = '';
                                    view = 'all';
                                "
                            >
                                {{ t(`automationsView.showAll`, { count: inShelf.length }) }}
                            </button>
                        </div>

                        <RowGroup v-for="group in groups" :key="group.key" :label="group.label">
                            <AutomationRow
                                v-for="automation in group.rows"
                                :key="automation.id"
                                :automation="automation"
                                :gist="gistOf(automation, shelfLabelOf(automation))"
                                :listener-sources="listenerSources"
                                :templates="offered"
                                :expanded="expanded.has(automation.id)"
                                :busy="save.isPending.value || setEnabled.isPending.value || run.isPending.value"
                                @toggle="toggle(automation, $event)"
                                @expand="toggleDetail(automation.id)"
                                @remove="confirmRemoveId = automation.id"
                                @run="runNow(automation)"
                                @install="installId = automation.id"
                            />
                        </RowGroup>
                    </div>
                </Await>

                <!-- What else could run here, offered on the everything shelf only: a picked shelf is a place to work, not to browse. -->
                <section
                    v-if="lens === `list` && activeShelf === undefined && (availableChores.length > 0 || availableSuggestions.length > 0)"
                    class="@container"
                >
                    <Section class="mb-2.5 px-1" :label="t(`automationsView.addAutomation`)" />
                    <div class="grid gap-1.5 @xl:grid-cols-2 @3xl:grid-cols-3">
                        <!-- A chevron, not a plus: each opens the composer prefilled, never a one-click create. -->
                        <button
                            v-for="recipe in [...availableChores, ...availableSuggestions]"
                            :key="recipe.id"
                            type="button"
                            :class="ui.addTile(`w-full items-start justify-start gap-2 px-3 py-2 text-left`)"
                            v-tooltip.top="recipe.description"
                            @click="openFromSuggestion(recipe)"
                        >
                            <Icon :name="glyph(recipe.icon) ?? `bolt`" class="shrink-0 text-2xs" />
                            <span class="min-w-0 flex-1">
                                <span class="block truncate font-medium">{{ recipe.title }}</span>
                                <span class="mt-0.5 block truncate text-2xs text-subtle">{{ recipe.note ?? recipe.description }}</span>
                            </span>
                            <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                        </button>
                    </div>
                </section>

                <!-- Keyed on the row, so opening a different Visitor chat remounts instead of showing the previous one's probes mid-flight. -->
                <VisitorChatInstallDialog
                    v-if="installing"
                    :key="installing.id"
                    :automation="installing"
                    :visible="true"
                    @update:visible="installId = undefined"
                />

                <!-- Deleting takes the run history with it and the daemon keeps no copy: the one action here with no undo. -->
                <ConfirmDialog
                    :open="confirmRemoveId !== undefined"
                    :header="t(`automationsView.deleteAutomation`)"
                    :confirm-label="t(`automationsView.delete`)"
                    confirm-icon="trash"
                    :loading="remove.isPending.value"
                    @cancel="confirmRemoveId = undefined"
                    @confirm="removeAutomation"
                >
                    <template #description>
                        {{ t(`automationsView.delete`) }} <b>{{ confirmRemoveId }}</b> {{ t(`automationsView.runHistoryCantUndone`) }}
                    </template>
                </ConfirmDialog>
            </div>
        </template>
    </SplitView>
</template>
