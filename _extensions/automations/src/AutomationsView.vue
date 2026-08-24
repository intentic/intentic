<script setup lang="ts">
import type { AutomationSummary, AutomationTemplate } from "@intentic/sandbox-contract";
import {
    Button,
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
import { computed, onUnmounted, reactive, ref } from "vue";
import AutomationComposer from "./AutomationComposer.vue";
import AutomationRow from "./AutomationRow.vue";
import FrontDeskInstallDialog from "./FrontDeskInstallDialog.vue";
import { since } from "./cronSchedule";
import { host } from "./host";
import { availableTemplates, glyph, useCatalog, withAvailability } from "./catalog";
import { useAutomations } from "./useAutomations";

/* Automations: agent wake-ups, native to every sandbox (no capability to enable). One automation = trigger
 * (cron, webhook, a live listener on the daemon's provider connection, or a moment in this workspace's own
 * work) → optional guard (a shell command the daemon runs in the workspace first; non-zero exit skips the
 * wake) → the prompt the agent wakes with. The daemon fires them and records the run history.
 *
 * The page is a LIST, not a gallery: one dense line per automation under two labelled groups (chores watch
 * this codebase, integrations are fired from outside it), because the question this page answers at any size
 * is "what is on, what fired, what broke". Everything that used to be a paragraph is now either a column, a
 * hover, or the row's own disclosure: each stock chore's explanation rides its suggestion pill.
 *
 * The chore SUGGESTIONS sit under the list rather than above it: they are the one kind of automation a user is
 * expected to want without knowing it exists, so they must stay visible, but they are an offer and the list is
 * the content. Turning one on writes a REAL automation into the list above, with its prompt, model and guard
 * editable like any other, there is deliberately no chore toggle that isn't an automation: a second place to
 * turn something on is a second place for it to disagree with itself.
 *
 * NOTHING ON THIS PAGE AUTHORS AN AUTOMATION IN A DIALOG. Creating opens a panel at the top of the list and
 * editing opens one inside the row, both at page width and both rendering the same <AutomationFields>: an
 * automation is the largest form in the app, and the modal that used to hold it had already been widened once
 * and had its template gallery folded away to cope. Keeping the list on screen is the other half: the questions
 * asked while writing one are "do I already have this?" and "what did the last one say?", and a modal covers
 * the only thing that answers them. */

const { automations, isLoading, pending, error: listError, save, setEnabled, remove, run, approve, reject } = useAutomations();
// Only draw the wait once it has lasted long enough to be worth seeing: see useLoadingReveal.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `automations`),
);
const { sources, templates, error: catalogError } = useCatalog();
/* The catalogue as this browser can act on it: the daemon says what exists, the live capability facts say what
 * is connected. Resolved once here and handed down, so the row, the composer and the shelves all read one
 * answer instead of each deriving their own. */
const listenerSources = computed(() => withAvailability(sources.value, host().workspace.capabilities()));
const offered = computed(() => availableTemplates(templates.value, host().workspace.capabilities()));

// The filter bar costs a line, so it earns it only once the list is long enough that scanning it by eye stops
// being instant. Below that the whole list is on screen and a filter is chrome in front of the answer.
const FILTER_FROM = 6;

type View = `all` | `on` | `off` | `failing`;

const createOpen = ref(false);
// List-action errors (toggle/delete/approve/reject): the dialog carries its own submit error.
const actionError = ref<string | undefined>(undefined);
// Rows with their detail unfolded.
const expanded = reactive(new Set<string>());
// The Front Desk whose install panel is open, by id rather than by object so it survives the list refetching
// underneath it (the panel polls, which invalidates nothing, but a save from inside it does).
const installId = ref<string | undefined>(undefined);
const installing = computed(() => automations.value.find((automation) => automation.id === installId.value));
// The chore pill mid-create, so its pill alone shows the wait.
const enabling = ref<string | undefined>(undefined);
// The automation awaiting a confirmed delete: a wake's whole run history goes with it, and nothing restores it.
const confirmRemoveId = ref<string | undefined>(undefined);
const search = ref(``);
const view = ref<View>(`all`);

const topError = computed(() => actionError.value ?? listError.value ?? catalogError.value);

/* The countdown holds' clock. One ticking ref for the whole section rather than a timer per row: it exists
 * only while a hold with a deadline is on screen, and a second's granularity is the reading a person does.
 * The daemon releases on its own coarser tick, so "starting…" (past-due, fleet busy or scan pending) is a
 * real state and gets said rather than showing a negative number. */
const now = ref(Date.now());
const countdownTimer = setInterval(() => {
    now.value = Date.now();
}, 1_000);
onUnmounted(() => clearInterval(countdownTimer));
const startsIn = (autoRunAt: number): string => {
    const seconds = Math.ceil((autoRunAt - now.value) / 1_000);
    return seconds <= 0 ? `starting…` : `starts in ${seconds}s unless you cancel`;
};

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
// Errors appears only once something IS failing: the tab showing up is itself the alert, where a permanent
// "Errors 0" would be a filter that only ever leads to an empty list. It survives while it is the active tab so
// a fixed run can't strand the user on a vanished filter.
const viewOptions = computed<{ label: string; value: View; badge: number }[]>(() => [
    { label: `All`, value: `all`, badge: counts.value.all },
    { label: `On`, value: `on`, badge: counts.value.on },
    { label: `Off`, value: `off`, badge: counts.value.off },
    ...(counts.value.failing > 0 || view.value === `failing` ? [{ label: `Errors`, value: `failing` as const, badge: counts.value.failing }] : []),
]);

// Enabled first, then by name: a FIXED order, so a row never moves under the cursor because a run landed. What
// needs attention is found through the Errors filter, not by re-sorting the page around it.
const shown = computed(() =>
    searched.value
        .filter((automation) =>
            view.value === `all` ? true : view.value === `failing` ? failing(automation) : automation.enabled === (view.value === `on`),
        )
        .toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id)),
);

// Shelved on the stored `chore` flag, not on the trigger: a nightly dependency sweep and a nightly Stripe poll
// are both `schedule`, and only one of them is about this codebase.
const chores = computed(() => shown.value.filter((automation) => automation.chore === true));
const integrations = computed(() => shown.value.filter((automation) => automation.chore !== true));
// A chore recipe with no automation of that id yet: what the suggestion strip offers. Matching on id (not on
// trigger) keeps a user's own second review chore from hiding the stock one.
const availableChores = computed(() =>
    offered.value.filter((template) => template.offer === `create` && !automations.value.some((automation) => automation.id === template.id)),
);

/* The same offer for templates marked `configure`: today just the Front Desk, which nobody arrives at this page
 * looking for. Unlike a `create` one, picking it opens the composer prefilled rather than saving: a Front Desk
 * with no allowed sites admits nobody, so silently creating the row would be creating a row that does nothing. */
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

/* Fire one by hand. The daemon acks the moment the fire starts and runs the turn detached, so what lands here is
 * whether it STARTED: the outcome shows up in the row's run history, which the mutation refetches. A schedule
 * fires exactly as its cron would (headless, main tree): a test that proved something else ran would prove
 * nothing about the 3 a.m. one it stands in for. */
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

// Turning a chore on for the first time: create it from its recipe, enabled. From here it is an ordinary row:
// the pill is gone because the thing it offered now exists.
const enableChore = async (recipe: AutomationTemplate): Promise<void> => {
    const trigger = recipe.trigger;
    // The two shapes a chore has: it reacts to a change in this workspace, or it sweeps it on a clock. A webhook
    // or a live provider connection is by definition the outside world, so it is not a chore.
    if (trigger.kind !== `workspace` && trigger.kind !== `schedule`) {
        return;
    }
    actionError.value = undefined;
    enabling.value = recipe.id;
    try {
        await save.mutateAsync({
            id: recipe.id,
            trigger: trigger.kind === `workspace` ? { kind: `workspace`, event: trigger.event } : { kind: `schedule`, cron: trigger.cron },
            ...(recipe.guard !== undefined ? { guard: recipe.guard } : {}),
            prompt: recipe.prompt,
            chore: true,
            enabled: true,
        });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not turn that chore on.`;
    } finally {
        enabling.value = undefined;
    }
};

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

// Approve a held wake (the agent runs now) or reject it (dropped, never runs).
const approvePending = async (id: string): Promise<void> => {
    actionError.value = undefined;
    try {
        await approve.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not approve the automation.`;
    }
};
const rejectPending = async (id: string): Promise<void> => {
    actionError.value = undefined;
    try {
        await reject.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not reject the automation.`;
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
        <PageHeader title="Automations" description="Wake your agent on a schedule, a webhook, a live provider event, or your fleet's own work.">
            <template #actions>
                <PageAction icon="plus" label="New automation" primary @click="createOpen = true" />
            </template>
        </PageHeader>

        <Notice v-if="topError" :of="noticeOf(topError)" class="mb-4" />

        <div class="flex flex-col gap-6">
            <!-- Held wakes: the only thing on this page that is waiting on the READER, so it stays at the top and
                 wears the warning border whatever the filter says. -->
            <section v-if="pending.length > 0">
                <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
                    <Icon name="lock" class="text-2xs text-warning" />
                    <span :class="ui.sectionLabel('text-warning')">Waiting for you</span>
                    <span class="text-2xs font-medium text-subtle">{{ pending.length }}</span>
                    <span class="text-2xs text-subtle">These fired and are held: the agent hasn't run yet.</span>
                </div>
                <div class="divide-y divide-line-subtle overflow-hidden rounded-lg border border-warning/40 bg-card">
                    <div v-for="item in pending" :key="item.id" class="flex items-center gap-2 px-2.5 py-1.5">
                        <span class="shrink-0 truncate text-xs font-medium text-content">{{ item.automationId }}</span>
                        <!-- A countdown hold runs ITSELF when the timer passes: the row's job is to say so
                             and keep the cancel in reach. An approval hold waits for the reader, as ever. -->
                        <span v-if="item.autoRunAt !== undefined" class="shrink-0 text-2xs font-medium text-warning">{{
                            startsIn(item.autoRunAt)
                        }}</span>
                        <span v-else class="shrink-0 text-2xs text-subtle">fired {{ since(item.createdAt) }}</span>
                        <code v-if="item.payload" class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle" v-tooltip.top="item.payload">
                            {{ item.payload }}
                        </code>
                        <span v-else class="flex-1"></span>
                        <Button
                            :label="item.autoRunAt !== undefined ? `Start now` : `Approve`"
                            size="small"
                            :disabled="approve.isPending.value"
                            @click="approvePending(item.id)"
                        >
                            <template #icon><Icon name="check" /></template>
                        </Button>
                        <Button
                            :label="item.autoRunAt !== undefined ? `Cancel` : `Reject`"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="reject.isPending.value"
                            @click="rejectPending(item.id)"
                        />
                    </div>
                </div>
            </section>

            <!-- Creating, in the list. Keyed on the prefill so picking a different suggestion while the panel is
                 already open remounts it on that template rather than leaving the previous one's fields up. -->
            <AutomationComposer
                :templates="offered"
                v-if="createOpen"
                :key="createPrefill?.id ?? `blank`"
                :prefill="createPrefill"
                :listener-sources="listenerSources"
                @created="expanded.add($event)"
                @close="closeComposer"
            />

            <!-- Filter bar: one line that answers "how many, how many on, is anything broken" before a single row
                 is read. Only once the list is long enough to need it. -->
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

            <!-- AN UNREAD LIST IS NOT AN EMPTY ONE. `automations` is `[]` both before the read lands and after
                 it lands empty, so the sentence below used to greet every single visit: including the ones
                 where the reader already has a page of automations, and then be replaced a moment later by the
                 list it had just denied. The outline says the same thing the empty state does about how many
                 rows are coming (nothing), without claiming anything about whether there are any. -->
            <template v-if="isLoading">
                <RowGroup v-if="outline" role="status" aria-busy="true">
                    <template #label><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></template>
                    <span class="sr-only">Reading your automations…</span>
                    <SkeletonRows :rows="3" description control />
                </RowGroup>
            </template>

            <div v-else-if="automations.length === 0" :class="ui.emptyState('py-5')">
                No automations yet: turn on a code chore below, or build your own with New automation.
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

            <!-- The same pills for things that are not chores but are equally easy to never find out about.
                 Separate section because the sentence under it is different: a chore costs nothing until its
                 check finds something, while these need a few fields before they do anything at all. -->
            <section v-if="availableSuggestions.length > 0">
                <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
                    <span :class="ui.sectionLabel()">Reach this agent from elsewhere</span>
                    <span class="text-2xs text-subtle">A few details to fill in, then it is a row like any other.</span>
                </div>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="recipe in availableSuggestions"
                        :key="recipe.id"
                        type="button"
                        :class="ui.addTile(`bg-card px-2.5 py-1.5`)"
                        v-tooltip.top="recipe.description"
                        @click="openFromSuggestion(recipe)"
                    >
                        <Icon name="plus" class="shrink-0 text-2xs text-subtle" />
                        <Icon v-if="recipe.icon" :name="glyph(recipe.icon)!" class="shrink-0 text-2xs" />
                        {{ recipe.title }}
                        <span v-if="recipe.note" class="text-2xs text-subtle">· {{ recipe.note }}</span>
                    </button>
                </div>
            </section>

            <!-- The offer, as pills rather than cards: one line each however many there are, and each one click
                 from being a real row above. -->
            <section v-if="availableChores.length > 0">
                <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
                    <span :class="ui.sectionLabel()">Add a code chore</span>
                    <span class="text-2xs text-subtle">Their check runs for free first: a turn is spent only when it finds something.</span>
                </div>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="recipe in availableChores"
                        :key="recipe.id"
                        type="button"
                        :class="ui.addTile(`bg-card px-2.5 py-1.5 disabled:cursor-default disabled:opacity-50`)"
                        :disabled="enabling !== undefined"
                        v-tooltip.top="recipe.description"
                        v-action="() => enableChore(recipe)"
                    >
                        <Icon
                            :name="enabling === recipe.id ? `spinner` : `plus`"
                            :spin="enabling === recipe.id"
                            class="shrink-0 text-2xs text-subtle"
                        />
                        <Icon v-if="recipe.icon" :name="glyph(recipe.icon)!" class="shrink-0 text-2xs" />
                        {{ recipe.title }}
                        <span v-if="recipe.note" class="text-2xs text-subtle">· {{ recipe.note }}</span>
                    </button>
                </div>
            </section>
        </div>

        <!-- Keyed on the row so re-opening a different Front Desk remounts the panel rather than showing the
             previous one's install probes while its own query is still in flight. -->
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
