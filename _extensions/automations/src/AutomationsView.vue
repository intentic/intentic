<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract";
import { Button, Card, cmp, Icon, Page, PageHeader } from "@intentic/extension-ui";
import { computed, reactive, ref } from "vue";
import AutomationRow from "./AutomationRow.vue";
import CreateAutomationDialog from "./CreateAutomationDialog.vue";
import { formatAt } from "./cronSchedule";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";
import { useAutomations } from "./useAutomations";

/* Automations: agent wake-ups, native to every sandbox (no capability to enable). One automation = trigger
 * (cron, webhook, a live listener on the daemon's provider connection, or a moment in this workspace's own
 * work) → optional guard (a shell command the daemon runs in the workspace first; non-zero exit skips the
 * wake) → the prompt the agent wakes with. The daemon fires them and records the run history.
 *
 * Two shelves, because the two kinds answer different questions. CODE CHORES watch this workspace — they fire
 * when your fleet settles a turn or lands work — and they are the ones a user wants without knowing they
 * exist, so the shelf lists the ones they DON'T have yet as off cards and one click creates the row.
 * Everything else is triggered from outside (a clock, a webhook, a live provider connection) and is listed
 * only once it exists, because you cannot want a Sentry automation before you have Sentry.
 *
 * Enabling a chore from its card writes a REAL automation, visible in the same list, with its prompt, model
 * and guard editable like any other. There is deliberately no chore toggle that isn't an automation: a second
 * place to turn something on is a second place for it to disagree with itself. */

const { automations, pending, error: listError, save, remove, approve, reject } = useAutomations();

const createOpen = ref(false);
// List-action errors (toggle/delete/approve/reject) — the dialog carries its own submit error.
const actionError = ref<string | null>(null);
// Rows with their run history unfolded.
const expanded = reactive(new Set<string>());
// The chore card mid-create, so its button alone shows the wait.
const enabling = ref<string | undefined>(undefined);

const topError = computed(() => actionError.value ?? listError.value);

const CHORE_RECIPES = AUTOMATION_RECIPES.filter((recipe) => recipe.chore === true);
// Shelved on the stored `chore` flag, not on the trigger: a nightly dependency sweep and a nightly Stripe poll
// are both `schedule`, and only one of them is about this codebase.
const chores = computed(() => automations.value.filter((automation) => automation.chore === true));
const integrations = computed(() => automations.value.filter((automation) => automation.chore !== true));
// A chore recipe with no automation of that id yet — what the shelf offers. Matching on id (not on trigger)
// keeps a user's own second review chore from hiding the stock one.
const availableChores = computed(() => CHORE_RECIPES.filter((recipe) => !automations.value.some((automation) => automation.id === recipe.id)));

// The enabled toggle is a plain re-post of the automation with the flag flipped (upsert keeps the run history).
const toggle = async (automation: AutomationSummary, enabled: boolean): Promise<void> => {
    actionError.value = null;
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
            // shelf the first time someone toggled it off and on.
            ...(automation.chore !== undefined ? { chore: automation.chore } : {}),
            enabled,
        });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not update the automation.`;
    }
};

// Turning a chore on for the first time: create it from its recipe, enabled. From here it is an ordinary row —
// the card is gone because the thing it offered now exists.
const enableChore = async (recipe: AutomationRecipe): Promise<void> => {
    const trigger = recipe.trigger;
    // The two shapes a chore has: it reacts to a change in this workspace, or it sweeps it on a clock. A webhook
    // or a live provider connection is by definition the outside world, so it is not a chore.
    if (trigger.kind !== `workspace` && trigger.kind !== `schedule`) {
        return;
    }
    actionError.value = null;
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

const removeAutomation = async (id: string): Promise<void> => {
    actionError.value = null;
    try {
        await remove.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not remove the automation.`;
    }
};

// Approve a held wake (the agent runs now) or reject it (dropped, never runs).
const approvePending = async (id: string): Promise<void> => {
    actionError.value = null;
    try {
        await approve.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not approve the automation.`;
    }
};
const rejectPending = async (id: string): Promise<void> => {
    actionError.value = null;
    try {
        await reject.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not reject the automation.`;
    }
};

const toggleHistory = (id: string): void => {
    if (!expanded.delete(id)) {
        expanded.add(id);
    }
};

// The prompt of the automation a pending approval belongs to, for a preview line (undefined if it was deleted).
const pendingPrompt = (automationId: string): string | undefined => automations.value.find((automation) => automation.id === automationId)?.prompt;
</script>

<template>
    <Page width="wide">
        <PageHeader
            title="Automations"
            description="Wake your agent on a schedule, on a webhook, instantly from live provider events, or on what your own fleet just did. An optional guard command runs in your workspace first and decides whether each wake actually happens."
        />

        <div v-if="topError" :class="cmp.alertDanger('mb-3')">{{ topError }}</div>

        <Card v-if="pending.length > 0" class="mb-3 flex flex-col gap-3 border-warning/40">
            <div class="flex items-center gap-2.5">
                <Icon name="clock" class="text-lg text-warning" />
                <div>
                    <h2 class="font-semibold leading-tight">Pending approvals</h2>
                    <p class="text-xs text-muted">These automations fired but are waiting for you — the agent hasn't run yet.</p>
                </div>
            </div>
            <div class="flex flex-col gap-2">
                <div v-for="item in pending" :key="item.id" class="rounded-lg border border-line bg-canvas px-3 py-2">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="truncate font-medium text-content">{{ item.automationId }}</span>
                                <span class="rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">fired {{ formatAt(item.createdAt) }}</span>
                            </div>
                            <p v-if="pendingPrompt(item.automationId)" class="mt-0.5 truncate text-2xs text-subtle">
                                {{ pendingPrompt(item.automationId) }}
                            </p>
                            <p v-if="item.payload" class="mt-0.5 truncate font-mono text-2xs text-subtle" v-tooltip.top="item.payload">
                                {{ item.payload }}
                            </p>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                            <Button label="Approve" size="small" :disabled="approve.isPending.value" @click="approvePending(item.id)">
                                <template #icon><Icon name="check" /></template>
                            </Button>
                            <Button
                                label="Reject"
                                size="small"
                                severity="secondary"
                                :disabled="reject.isPending.value"
                                @click="rejectPending(item.id)"
                            >
                                <template #icon><Icon name="times" /></template>
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Card>

        <!-- Code chores. First on the page because it is the shelf with something to offer a user who has never
             opened this page before — everything below it only ever lists what already exists. -->
        <Card class="mb-3 flex flex-col gap-3">
            <div class="flex items-center gap-2.5">
                <Icon name="eye" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Code chores</h2>
                    <p class="text-xs text-muted">
                        Background maintenance of your own codebase — some react to what your fleet just did, some sweep on a schedule. The
                        tool-driven ones run their check for free first and only spend a turn when it actually finds something. Every run is still an
                        agent turn on your hardware, so they all start off.
                    </p>
                </div>
            </div>

            <div v-if="chores.length > 0" class="flex flex-col gap-2">
                <AutomationRow
                    v-for="chore in chores"
                    :key="chore.id"
                    :automation="chore"
                    :expanded="expanded.has(chore.id)"
                    @toggle="toggle(chore, $event)"
                    @history="toggleHistory(chore.id)"
                    @remove="removeAutomation(chore.id)"
                />
            </div>

            <!-- The off state. A card is an OFFER, not a setting: turning one on writes the automation above,
                 where its prompt, model and guard are yours to edit. -->
            <div v-if="availableChores.length > 0" class="grid gap-2 sm:grid-cols-2">
                <div
                    v-for="recipe in availableChores"
                    :key="recipe.id"
                    class="flex flex-col gap-2 rounded-lg border border-dashed border-line bg-overlay/40 px-3 py-2.5"
                >
                    <div class="flex items-center gap-2">
                        <Icon v-if="recipe.icon" :name="recipe.icon" class="shrink-0 text-muted" />
                        <span class="min-w-0 truncate font-medium text-content">{{ recipe.title }}</span>
                    </div>
                    <p class="text-2xs leading-relaxed text-muted">{{ recipe.description }}</p>
                    <div class="mt-auto flex items-center justify-between gap-2 pt-0.5">
                        <span v-if="recipe.note" class="truncate text-2xs text-subtle">{{ recipe.note }}</span>
                        <span v-else></span>
                        <Button
                            label="Turn on"
                            size="small"
                            severity="secondary"
                            :disabled="enabling !== undefined"
                            :loading="enabling === recipe.id"
                            @click="enableChore(recipe)"
                        >
                            <template #icon><Icon name="plus" /></template>
                        </Button>
                    </div>
                </div>
            </div>

            <div v-if="chores.length === 0 && availableChores.length === 0" :class="cmp.emptyState('py-6')">
                No chores available — build one from New automation with a workspace trigger.
            </div>
        </Card>

        <Card class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2.5">
                    <Icon name="clock" class="text-lg text-muted" />
                    <div>
                        <h2 class="font-semibold leading-tight">Scheduled wake-ups</h2>
                        <p class="text-xs text-muted">Each automation runs as a fresh agent session; its transcript appears with your chats.</p>
                    </div>
                </div>
                <Button label="New automation" size="small" @click="createOpen = true">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>

            <div v-if="integrations.length === 0" :class="cmp.emptyState('py-6')">
                No automations yet — schedule your agent's first wake-up.
            </div>

            <div v-else class="flex flex-col gap-2">
                <AutomationRow
                    v-for="automation in integrations"
                    :key="automation.id"
                    :automation="automation"
                    :expanded="expanded.has(automation.id)"
                    @toggle="toggle(automation, $event)"
                    @history="toggleHistory(automation.id)"
                    @remove="removeAutomation(automation.id)"
                />
            </div>
        </Card>

        <CreateAutomationDialog v-model:visible="createOpen" />
    </Page>
</template>
