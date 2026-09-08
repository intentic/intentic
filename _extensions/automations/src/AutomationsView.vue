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
    StatusTally,
    type TallyItem,
    useLoadingReveal,
    vAction,
} from "@intentic/extension-ui";
import { computed, reactive, ref } from "vue";
import AutomationComposer from "./AutomationComposer.vue";
import AutomationRow from "./AutomationRow.vue";
import FrontDeskInstallDialog from "./FrontDeskInstallDialog.vue";
import { nextIn } from "./cronSchedule";
import { host } from "./host";
import { availableTemplates, glyph, useCatalog, withAvailability } from "./catalog";
import { useAutomations } from "./useAutomations";

// Automations: trigger, then optional guard, then the prompt the agent wakes with; the daemon fires them and records
// history. The page answers three questions top-down: is anything wrong (the tally), what's standing (two shelves of
// rows), what else could be (the offers below). Creating and editing happen inline, never in a dialog.

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
// Reads the whole list, not the filtered one, since it sits above the filter and answers a different question
// ("anything wrong", not "in this view"). Only `on` is always shown; a zero elsewhere is dropped.
const tally = computed<readonly TallyItem[]>(() => [
    { label: `on`, value: automations.value.filter((automation) => automation.enabled).length, variant: `success`, always: true },
    { label: `paused`, value: automations.value.filter((automation) => !automation.enabled).length, variant: `neutral` },
    { label: `failing`, value: automations.value.filter(failing).length, variant: `danger` },
]);
// The soonest due time across every enabled row, a fact no single row can give; absent is an honest silence, not a
// zero.
const nextFire = computed<number | undefined>(() => {
    const due = automations.value.flatMap((automation) => (automation.enabled && automation.nextRun !== undefined ? [automation.nextRun] : []));
    return due.length === 0 ? undefined : Math.min(...due);
});

// The Errors tab appears only once something fails, so its presence is itself the alert; it stays while active so a
// fixed run can't strand the filter.
const viewOptions = computed<{ label: string; value: View; badge: number }[]>(() => [
    { label: `All`, value: `all`, badge: counts.value.all },
    { label: `On`, value: `on`, badge: counts.value.on },
    { label: `Off`, value: `off`, badge: counts.value.off },
    ...(counts.value.failing > 0 || view.value === `failing` ? [{ label: `Errors`, value: `failing` as const, badge: counts.value.failing }] : []),
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
        <PageHeader title="Automations">
            <!--
                On the title row, not under it, to spend that height on the body instead. Hidden while loading, since "0 on" is a claim the list is
                about to contradict.
            -->
            <template #info>
                <StatusTally v-if="!isLoading && automations.length > 0" :items="tally" class="ml-2">
                    <span v-if="nextFire !== undefined" class="text-xs text-subtle">next {{ nextIn(nextFire) }}</span>
                </StatusTally>
            </template>
            <template #actions>
                <PageAction icon="plus" label="New automation" primary @click="createOpen = true" />
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

            <!--
                One line answering how many, how many on, anything broken, before a single row is read; shown only once the list is long enough to
                need it.
            -->
            <div v-if="automations.length >= FILTER_FROM" class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <SearchBar
                    v-model="search"
                    variant="field"
                    clearable
                    aria-label="Filter automations"
                    placeholder="Filter by name or prompt…"
                    class="min-w-56 max-w-sm flex-1"
                />
                <SegmentedControl v-model="view" :options="viewOptions" class="ml-auto" />
            </div>

            <!--
                `automations` is `[]` both before the read lands and once it lands truly empty; the skeleton says "rows are coming" without claiming
                whether any exist, unlike the empty-state text below.
            -->
            <template v-if="isLoading">
                <RowGroup v-if="outline" role="status" aria-busy="true">
                    <template #label><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></template>
                    <span class="sr-only">Reading your automations…</span>
                    <SkeletonRows :rows="3" description control />
                </RowGroup>
            </template>

            <!--
                Names both doors out without drawing either as a button: New automation is already the page's one accent control, and the offers
                below are real controls a click away.
            -->
            <div v-else-if="automations.length === 0" :class="ui.emptyState('flex flex-col items-center gap-1 py-6')">
                <span class="text-sm text-content">Nothing runs on its own yet.</span>
                <span>Take one of the offers below, or build your own with <b class="font-medium text-muted">New automation</b>.</span>
            </div>
            <div v-else-if="shown.length === 0" :class="ui.emptyState('py-5')">
                Nothing matches this filter.
                <button
                    type="button"
                    class="cursor-pointer text-link hover:underline"
                    @click="
                        search = '';
                        view = 'all';
                    "
                >
                    Show all {{ automations.length }}
                </button>
            </div>

            <RowGroup v-if="chores.length > 0" label="Code chores" :count="chores.length" caption="maintenance of this codebase">
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

            <RowGroup v-if="integrations.length > 0" label="Integrations" :count="integrations.length" caption="fired from outside this workspace">
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

            <!--
                One section, one grid, not two rows of wrapping pills: a grid keeps every box the same size and lines up the note under the title.
                Two labelled runs, matching the composer's own template gallery, since a chore's sentence genuinely differs from the rest's.
            -->
            <section v-if="availableChores.length > 0 || availableSuggestions.length > 0" class="@container">
                <div class="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1">
                    <span :class="ui.sectionLabel()">Add an automation</span>
                    <span class="text-2xs text-subtle">Things this sandbox can do that nobody has asked it for yet.</span>
                </div>
                <div class="flex flex-col gap-3">
                    <div v-if="availableChores.length > 0" class="flex flex-col gap-1.5">
                        <span class="px-1 text-2xs text-subtle">
                            <b class="font-medium text-muted">Code chores</b> · their check runs for free first, so a turn is spent only when it finds
                            something.
                        </span>
                        <div class="grid gap-1.5 @xl:grid-cols-2 @3xl:grid-cols-3">
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
                                <!--
                                    A chevron, not a plus: a recipe can't know which providers are connected, so this opens the composer prefilled
                                    instead of guessing a model or creating a row that can't fire.
                                -->
                                <Icon name="chevron-right" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                            </button>
                        </div>
                    </div>

                    <div v-if="availableSuggestions.length > 0" class="flex flex-col gap-1.5">
                        <span class="px-1 text-2xs text-subtle">
                            <b class="font-medium text-muted">Reach this agent from elsewhere</b> · a few details to fill in, then it is a row like any
                            other.
                        </span>
                        <div class="grid gap-1.5 @xl:grid-cols-2 @3xl:grid-cols-3">
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
            header="Delete automation"
            confirm-label="Delete"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @cancel="confirmRemoveId = undefined"
            @confirm="removeAutomation"
        >
            <p class="text-sm text-content">
                Delete <b>{{ confirmRemoveId }}</b> and its run history? This can't be undone.
            </p>
        </ConfirmDialog>
    </Page>
</template>
