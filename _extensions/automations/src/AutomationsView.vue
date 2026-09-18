<script setup lang="ts">
import type { AutomationSummary, AutomationTemplate } from "@intentic/sandbox-contract";
import {
    ui,
    ConfirmDialog,
    Icon,
    Notice,
    noticeOf,
    Page,
    PageAction,
    PageHeader,
    RowGroup,
    SearchBar,
    SegmentedControl,
    SkeletonRows,
    useLoadingReveal,
    vAction,
} from "@intentic/extension-ui";
import { computed, reactive, ref } from "vue";
import AutomationComposer from "./AutomationComposer.vue";
import AutomationRow from "./AutomationRow.vue";
import FrontDeskInstallDialog from "./FrontDeskInstallDialog.vue";
import { host } from "./host";
import { availableTemplates, glyph, useCatalog, withAvailability } from "./catalog";
import { useAutomations } from "./useAutomations";
import { t } from "./i18n.js";

// Automations: trigger, then optional guard, then the prompt the agent wakes with; the daemon fires them and records
// history. The page lists what's standing (two shelves of rows) and what else could be (the offers below). Creating
// and editing happen inline, never in a dialog.

const { automations, isLoading, error: listError, save, setEnabled, remove, run } = useAutomations();
// Only draws the wait once it's lasted long enough to be worth seeing.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `automations`),
);
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

const topError = computed(() => actionError.value ?? listError.value ?? catalogError.value);

const failing = (automation: AutomationSummary): boolean => automation.enabled && automation.runs[0]?.outcome === `error`;
const matchesSearch = (automation: AutomationSummary): boolean => {
    const needle = search.value.trim().toLowerCase();
    return needle === `` || automation.id.toLowerCase().includes(needle) || automation.prompt.toLowerCase().includes(needle);
};
const searched = computed(() => automations.value.filter(matchesSearch));
const counts = computed(() => ({
    all: searched.value.length,
    on: searched.value.filter((automation) => automation.enabled).length,
    off: searched.value.filter((automation) => !automation.enabled).length,
    failing: searched.value.filter(failing).length,
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
            view.value === `all` ? true : view.value === `failing` ? failing(automation) : automation.enabled === (view.value === `on`),
        )
        .toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id)),
);

// Split by the stored `chore` flag, not the trigger: two nightly schedules need not both concern this codebase.
const chores = computed(() => shown.value.filter((automation) => automation.chore === true));
const integrations = computed(() => shown.value.filter((automation) => automation.chore !== true));
// A chore recipe with no automation of that id yet. Matching on id, not trigger, so a user's own second review chore
// doesn't hide the stock one.
const availableChores = computed(() =>
    offered.value.filter((template) => template.offer === `create` && !automations.value.some((automation) => automation.id === template.id)),
);

// Templates marked `configure` (today just Front Desk): picking one opens the composer prefilled, not a silent save,
// since an unconfigured Front Desk would admit nobody.
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
};

// Enablement is its own mutation: a switch changes one fact and never serializes the automation around it.
const toggle = async (automation: AutomationSummary, enabled: boolean): Promise<void> => {
    actionError.value = undefined;
    try {
        await setEnabled.mutateAsync({ id: automation.id, enabled });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not update the automation.`;
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
        actionError.value = err instanceof Error ? err.message : `Could not run the automation.`;
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
        actionError.value = err instanceof Error ? err.message : `Could not remove the automation.`;
    }
};

const toggleDetail = (id: string): void => {
    if (!expanded.delete(id)) {
        expanded.add(id);
    }
};
</script>

<template>
    <Page width="wide">
        <PageHeader :title="t(`automationsView.automations`)">
            <template #actions>
                <PageAction icon="plus" :label="t(`automationsView.newAutomation`)" primary @click="createOpen = true" />
            </template>
        </PageHeader>

        <Notice v-if="topError" :of="noticeOf(topError)" class="mb-4" />

        <div class="flex flex-col gap-6">
            <!-- Keyed on the prefill, so picking a different suggestion while open remounts fresh instead of keeping stale fields. -->
            <AutomationComposer
                :templates="offered"
                v-if="createOpen"
                :key="createPrefill?.id ?? `blank`"
                :prefill="createPrefill"
                :listener-sources="listenerSources"
                @created="expanded.add($event)"
                @close="closeComposer"
            />

            <!-- The summary reports total, active, and failing automations before the list. -->
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

            <!-- Skeletons distinguish the pending list from a true empty state. -->
            <template v-if="isLoading">
                <RowGroup v-if="outline" role="status" aria-busy="true">
                    <template #label><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></template>
                    <span class="sr-only">{{ t(`automationsView.readingAutomations`) }}</span>
                    <SkeletonRows :rows="3" description control />
                </RowGroup>
            </template>

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
            <div v-else-if="shown.length === 0" :class="ui.emptyState('py-5')">
                {{ t(`automationsView.nothingMatchesFilter`) }}
                <button
                    type="button"
                    class="cursor-pointer text-link hover:underline"
                    @click="
                        search = '';
                        view = 'all';
                    "
                >
                    {{ t(`automationsView.showAll`, { count: automations.length }) }}
                </button>
            </div>

            <RowGroup v-if="chores.length > 0" :label="t(`automationsView.codeChores`)">
                <AutomationRow
                    v-for="chore in chores"
                    :key="chore.id"
                    :automation="chore"
                    :listener-sources="listenerSources"
                    :templates="offered"
                    :expanded="expanded.has(chore.id)"
                    :busy="save.isPending.value || setEnabled.isPending.value || run.isPending.value"
                    @toggle="toggle(chore, $event)"
                    @expand="toggleDetail(chore.id)"
                    @remove="confirmRemoveId = chore.id"
                    @run="runNow(chore)"
                    @install="installId = chore.id"
                />
            </RowGroup>

            <RowGroup v-if="integrations.length > 0" :label="t(`automationsView.integrations`)">
                <AutomationRow
                    v-for="automation in integrations"
                    :key="automation.id"
                    :automation="automation"
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

            <!-- Automation sections use one equal-width grid. -->
            <section v-if="availableChores.length > 0 || availableSuggestions.length > 0" class="@container">
                <div class="mb-2.5 px-1">
                    <span :class="ui.sectionLabel()">{{ t(`automationsView.addAutomation`) }}</span>
                </div>
                <div class="flex flex-col gap-3">
                    <div v-if="availableChores.length > 0" class="grid gap-1.5 @xl:grid-cols-2 @3xl:grid-cols-3">
                            <button
                                v-for="recipe in availableChores"
                                :key="recipe.id"
                                type="button"
                                :class="ui.addTile(`w-full items-start justify-start gap-2 px-3 py-2 text-left`)"
                                v-tooltip.top="recipe.description"
                                @click="openFromSuggestion(recipe)"
                            >
                                <Icon :name="glyph(recipe.icon) ?? `bolt`" class="mt-0.5 shrink-0 text-2xs" />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate font-medium">{{ recipe.title }}</span>
                                    <span class="mt-0.5 block truncate text-2xs text-subtle">{{ recipe.note ?? recipe.description }}</span>
                                </span>
                                <!-- The chevron opens the recipe details; it does not create a run. -->
                                <Icon name="chevron-right" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                            </button>
                    </div>

                    <div v-if="availableSuggestions.length > 0" class="grid gap-1.5 @xl:grid-cols-2 @3xl:grid-cols-3">
                            <button
                                v-for="recipe in availableSuggestions"
                                :key="recipe.id"
                                type="button"
                                :class="ui.addTile(`w-full items-start justify-start gap-2 px-3 py-2 text-left`)"
                                v-tooltip.top="recipe.description"
                                @click="openFromSuggestion(recipe)"
                            >
                                <Icon :name="glyph(recipe.icon) ?? `bolt`" class="mt-0.5 shrink-0 text-2xs" />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate font-medium">{{ recipe.title }}</span>
                                    <span class="mt-0.5 block truncate text-2xs text-subtle">{{ recipe.note ?? recipe.description }}</span>
                                </span>
                                <!-- A chevron, not a plus: this also opens the composer prefilled, not a one-click create. -->
                                <Icon name="chevron-right" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                            </button>
                    </div>
                </div>
            </section>
        </div>

        <!-- Keyed on the row, so opening a different Front Desk remounts instead of showing the previous one's probes mid-flight. -->
        <FrontDeskInstallDialog
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
            <p class="text-sm text-content">
                {{ t(`automationsView.delete`) }} <b>{{ confirmRemoveId }}</b> {{ t(`automationsView.runHistoryCantUndone`) }}
            </p>
        </ConfirmDialog>
    </Page>
</template>
