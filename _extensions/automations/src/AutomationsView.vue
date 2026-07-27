<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract";
import { Button, cmp, Dialog, Icon, InfoHint, Page, PageHeader, RowGroup, Segmented } from "@intentic/extension-ui";
import { computed, reactive, ref } from "vue";
import AutomationRow from "./AutomationRow.vue";
import CreateAutomationDialog from "./CreateAutomationDialog.vue";
import { since } from "./cronSchedule";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";
import { useAutomations } from "./useAutomations";

/* Automations: agent wake-ups, native to every sandbox (no capability to enable). One automation = trigger
 * (cron, webhook, a live listener on the daemon's provider connection, or a moment in this workspace's own
 * work) → optional guard (a shell command the daemon runs in the workspace first; non-zero exit skips the
 * wake) → the prompt the agent wakes with. The daemon fires them and records the run history.
 *
 * The page is a LIST, not a gallery: one dense line per automation under two labelled groups (chores watch
 * this codebase, integrations are fired from outside it), because the question this page answers at any size
 * is "what is on, what fired, what broke". Everything that used to be a paragraph is now either a column, a
 * hover, or the row's own disclosure — the explanation of how automations fire lives in the header hint, and
 * each stock chore's explanation on its suggestion pill.
 *
 * The chore SUGGESTIONS sit under the list rather than above it: they are the one kind of automation a user is
 * expected to want without knowing it exists, so they must stay visible, but they are an offer and the list is
 * the content. Turning one on writes a REAL automation into the list above, with its prompt, model and guard
 * editable like any other — there is deliberately no chore toggle that isn't an automation: a second place to
 * turn something on is a second place for it to disagree with itself. */

const { automations, pending, error: listError, save, remove, approve, reject } = useAutomations();

// The filter bar costs a line, so it earns it only once the list is long enough that scanning it by eye stops
// being instant. Below that the whole list is on screen and a filter is chrome in front of the answer.
const FILTER_FROM = 6;

type View = `all` | `on` | `off` | `failing`;

const createOpen = ref(false);
// List-action errors (toggle/delete/approve/reject) — the dialog carries its own submit error.
const actionError = ref<string | undefined>(undefined);
// Rows with their detail unfolded.
const expanded = reactive(new Set<string>());
// The chore pill mid-create, so its pill alone shows the wait.
const enabling = ref<string | undefined>(undefined);
// The automation awaiting a confirmed delete — a wake's whole run history goes with it, and nothing restores it.
const confirmRemoveId = ref<string | undefined>(undefined);
const search = ref(``);
const view = ref<View>(`all`);

const topError = computed(() => actionError.value ?? listError.value);

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
// Errors appears only once something IS failing — the tab showing up is itself the alert, where a permanent
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

const CHORE_RECIPES = AUTOMATION_RECIPES.filter((recipe) => recipe.chore === true);
// Shelved on the stored `chore` flag, not on the trigger: a nightly dependency sweep and a nightly Stripe poll
// are both `schedule`, and only one of them is about this codebase.
const chores = computed(() => shown.value.filter((automation) => automation.chore === true));
const integrations = computed(() => shown.value.filter((automation) => automation.chore !== true));
// A chore recipe with no automation of that id yet — what the suggestion strip offers. Matching on id (not on
// trigger) keeps a user's own second review chore from hiding the stock one.
const availableChores = computed(() => CHORE_RECIPES.filter((recipe) => !automations.value.some((automation) => automation.id === recipe.id)));

// The enabled toggle is a plain re-post of the automation with the flag flipped (upsert keeps the run history).
const toggle = async (automation: AutomationSummary, enabled: boolean): Promise<void> => {
    actionError.value = undefined;
    try {
        await save.mutateAsync({
            id: automation.id,
            trigger: automation.trigger,
            ...(automation.guard !== undefined ? { guard: automation.guard } : {}),
            prompt: automation.prompt,
            ...(automation.agent !== undefined ? { agent: automation.agent } : {}),
            ...(automation.harness !== undefined ? { harness: automation.harness } : {}),
            ...(automation.model !== undefined ? { model: automation.model } : {}),
            ...(automation.requireApproval !== undefined ? { requireApproval: automation.requireApproval } : {}),
            // Round-tripped like every other stored field — dropping it here would move a chore to the other
            // group the first time someone toggled it off and on.
            ...(automation.chore !== undefined ? { chore: automation.chore } : {}),
            enabled,
        });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not update the automation.`;
    }
};

// Turning a chore on for the first time: create it from its recipe, enabled. From here it is an ordinary row —
// the pill is gone because the thing it offered now exists.
const enableChore = async (recipe: AutomationRecipe): Promise<void> => {
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
            <template #info>
                <InfoHint label="How an automation fires">
                    <span class="block text-sm font-medium text-content">Trigger → guard → wake</span>
                    <span class="mt-1 block text-xs text-muted">
                        An optional <b>guard</b> command runs in your workspace first: exit 0 wakes the agent, anything else skips that run and is
                        recorded as <b>skipped</b>.
                    </span>
                    <span class="mt-2 block text-xs text-muted">
                        Every wake is a fresh agent session on your own hardware; its transcript appears with your chats.
                    </span>
                </InfoHint>
            </template>
            <template #actions>
                <Button label="New automation" size="small" @click="createOpen = true">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </template>
        </PageHeader>

        <div v-if="topError" :class="cmp.alertDanger('mb-4')">{{ topError }}</div>

        <div class="flex flex-col gap-6">
            <!-- Held wakes: the only thing on this page that is waiting on the READER, so it stays at the top and
                 wears the warning border whatever the filter says. -->
            <section v-if="pending.length > 0">
                <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
                    <Icon name="lock" class="text-2xs text-warning" />
                    <span :class="cmp.sectionLabel('text-warning')">Waiting for you</span>
                    <span class="text-2xs font-medium text-subtle">{{ pending.length }}</span>
                    <span class="text-2xs text-subtle">These fired and are held — the agent hasn't run yet.</span>
                </div>
                <div class="divide-y divide-line overflow-hidden rounded-lg border border-warning/40 bg-card">
                    <div v-for="item in pending" :key="item.id" class="flex items-center gap-2 px-2.5 py-1.5">
                        <span class="shrink-0 truncate text-xs font-medium text-content">{{ item.automationId }}</span>
                        <span class="shrink-0 text-2xs text-subtle">fired {{ since(item.createdAt) }}</span>
                        <code v-if="item.payload" class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle" v-tooltip.top="item.payload">
                            {{ item.payload }}
                        </code>
                        <span v-else class="flex-1"></span>
                        <Button label="Approve" size="small" :disabled="approve.isPending.value" @click="approvePending(item.id)">
                            <template #icon><Icon name="check" /></template>
                        </Button>
                        <Button
                            label="Reject"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="reject.isPending.value"
                            @click="rejectPending(item.id)"
                        />
                    </div>
                </div>
            </section>

            <!-- Filter bar: one line that answers "how many, how many on, is anything broken" before a single row
                 is read. Only once the list is long enough to need it. -->
            <div v-if="automations.length >= FILTER_FROM" class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label
                    class="flex min-w-56 max-w-sm flex-1 items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 focus-within:border-line-strong"
                >
                    <Icon name="search" class="shrink-0 text-2xs text-subtle" />
                    <input
                        v-model="search"
                        placeholder="Filter by name or prompt…"
                        aria-label="Filter automations"
                        class="min-w-0 flex-1 bg-transparent text-xs text-content placeholder:text-subtle focus:outline-none"
                    />
                    <button
                        v-if="search !== ''"
                        type="button"
                        class="shrink-0 cursor-pointer text-2xs text-subtle hover:text-content"
                        aria-label="Clear filter"
                        @click="search = ''"
                    >
                        <Icon name="times" />
                    </button>
                </label>
                <Segmented v-model="view" :options="viewOptions" class="ml-auto" />
            </div>

            <div v-if="automations.length === 0" :class="cmp.emptyState('py-5')">
                No automations yet — turn on a code chore below, or build your own with New automation.
            </div>
            <div v-else-if="shown.length === 0" :class="cmp.emptyState('py-5')">
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
                    :expanded="expanded.has(chore.id)"
                    :busy="save.isPending.value"
                    @toggle="toggle(chore, $event)"
                    @expand="toggleDetail(chore.id)"
                    @remove="confirmRemoveId = chore.id"
                />
            </RowGroup>

            <RowGroup v-if="integrations.length > 0" label="Integrations" :count="integrations.length" caption="fired from outside this workspace">
                <AutomationRow
                    v-for="automation in integrations"
                    :key="automation.id"
                    :automation="automation"
                    :expanded="expanded.has(automation.id)"
                    :busy="save.isPending.value"
                    @toggle="toggle(automation, $event)"
                    @expand="toggleDetail(automation.id)"
                    @remove="confirmRemoveId = automation.id"
                />
            </RowGroup>

            <!-- The offer, as pills rather than cards: one line each however many there are, and each one click
                 from being a real row above. -->
            <section v-if="availableChores.length > 0">
                <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
                    <span :class="cmp.sectionLabel()">Add a code chore</span>
                    <span class="text-2xs text-subtle">Their check runs for free first — a turn is spent only when it finds something.</span>
                </div>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="recipe in availableChores"
                        :key="recipe.id"
                        type="button"
                        class="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-line bg-card px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-content disabled:cursor-default disabled:opacity-50"
                        :disabled="enabling !== undefined"
                        v-tooltip.top="recipe.description"
                        @click="enableChore(recipe)"
                    >
                        <Icon
                            :name="enabling === recipe.id ? `spinner` : `plus`"
                            :spin="enabling === recipe.id"
                            class="shrink-0 text-2xs text-subtle"
                        />
                        <Icon v-if="recipe.icon" :name="recipe.icon" class="shrink-0 text-2xs" />
                        {{ recipe.title }}
                        <span v-if="recipe.note" class="text-2xs text-subtle">· {{ recipe.note }}</span>
                    </button>
                </div>
            </section>
        </div>

        <CreateAutomationDialog v-model:visible="createOpen" />

        <!-- Deleting takes the run history with it and the daemon keeps no copy — the one action here with no undo. -->
        <Dialog
            :visible="confirmRemoveId !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '24rem' }"
            header="Delete automation"
            @update:visible="confirmRemoveId = undefined"
        >
            <p class="text-sm text-content">
                Delete <b>{{ confirmRemoveId }}</b> and its run history? This can't be undone.
            </p>
            <template #footer>
                <Button label="Cancel" severity="secondary" :text="true" @click="confirmRemoveId = undefined" />
                <Button label="Delete" severity="danger" :loading="remove.isPending.value" @click="removeAutomation">
                    <template #icon><Icon name="trash" /></template>
                </Button>
            </template>
        </Dialog>
    </Page>
</template>
