<script setup lang="ts">
import { AUTOMATION_RECIPES, type AutomationRecipe } from "@intentic-app/catalog";
import { type AutomationRun, type AutomationSummary } from "@intentic-app/api-contract";
import { Card, cmp, CopyButton, Page, StatusBadge, type StatusVariant } from "@intentic-app/ui";
import { Cron } from "croner";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, reactive, ref } from "vue";
import { cronOf, defaultSchedule, parseCron, scheduleLabel } from "../composables/extensions/cronSchedule";
import { useAutomations } from "../composables/extensions/useAutomations";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useSandbox } from "../composables/useSandbox";

/* Automations: agent wake-ups, native to every sandbox (no capability to enable). One automation = trigger
 * (cron, webhook, or a live listener on the daemon's provider connection) → optional guard (a shell command
 * the daemon runs in the workspace first; non-zero exit skips the wake) → the prompt the agent wakes with.
 * The daemon fires them and records the run history. */

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Small selectable pills (Repeats, Days, Model, Events, Source) — borderless; selection = a muted brand tint with readable brand text.
const CHIP_BASE = `rounded-md px-3 py-1.5 text-xs font-medium transition-colors`;
const CHIP_SELECTED = `bg-primary-600/15 text-link`;
const CHIP_IDLE = `text-muted hover:bg-overlay hover:text-content`;
// Larger tappable cards (recipe templates, Trigger) — idle sits on the overlay surface so it reads as a control without a border; selection tints and adds a brand ring.
const CARD_SELECTED = `bg-primary-600/15 text-link ring-1 ring-inset ring-primary-500/40`;
const CARD_IDLE = `bg-overlay text-muted hover:text-content`;
const FREQ_OPTIONS = [
    { value: `minutes`, label: `Minutes` },
    { value: `hourly`, label: `Hourly` },
    { value: `daily`, label: `Daily` },
    { value: `weekly`, label: `Weekly` },
    { value: `monthly`, label: `Monthly` },
    { value: `custom`, label: `Custom` },
] as const;
// Claude models a wake can be pinned to (automations always run the Claude adapter); "" = the account default.
// ponytail: duplicated from ChatPanel.vue's inline models computed; extract a shared const if a third consumer appears.
const MODEL_OPTIONS = [
    { value: ``, label: `Default` },
    { value: `opus`, label: `Opus` },
    { value: `sonnet`, label: `Sonnet` },
    { value: `haiku`, label: `Haiku` },
] as const;
const DAY_OPTIONS = [
    { value: 1, label: `Mon` },
    { value: 2, label: `Tue` },
    { value: 3, label: `Wed` },
    { value: 4, label: `Thu` },
    { value: 5, label: `Fri` },
    { value: 6, label: `Sat` },
    { value: 0, label: `Sun` },
] as const;
// Live sources the daemon can hold a realtime connection to, the event kinds each emits, and a starter prompt.
// Grows alongside the trigger's provider/eventType enums and a daemon ListenerSource.
const LISTENER_SOURCES = {
    discord: {
        label: `Discord`,
        logo: `discord`,
        events: [
            { value: `message`, label: `Messages` },
            { value: `voice_transcript`, label: `Voice transcripts` },
        ],
        starterPrompt: `Discord events just arrived — each line of the event payload is one JSON event: type \`message\` (a new message: author, channelId, content; \`mentioned: true\` when the bot was tagged or replied to) or \`voice_transcript\` (a finished voice session — read the transcript at its \`extra.path\`). Handle messages that need attention with your Discord capability; turn transcripts into notes and action items in the workspace.`,
    },
} satisfies Record<
    string,
    { label: string; logo: string; events: readonly { value: `message` | `voice_transcript`; label: string }[]; starterPrompt: string }
>;

const { automations, pending, error: listError, save, remove, approve, reject } = useAutomations();
const { capabilities } = useCapabilities();
const { daemonUrl } = useSandbox();

const createOpen = ref(false);
// Guard/model/approval fold away by default — revealed on demand or when a recipe prefills a guard.
const advancedOpen = ref(false);
const form = reactive({
    kind: `schedule` as `schedule` | `event` | `listener`,
    id: ``,
    guard: ``,
    prompt: ``,
    model: ``,
    requireApproval: false,
    provider: `discord` as keyof typeof LISTENER_SOURCES,
    channelId: ``,
    eventType: undefined as `message` | `voice_transcript` | undefined,
    mentioned: false,
});
const schedule = reactive(defaultSchedule());
const actionError = ref<string | null>(null);
const pickedRecipe = ref<AutomationRecipe | undefined>(undefined);
// After creating an event automation the dialog stays open on this id to show the webhook URL + setup steps.
const savedId = ref<string | undefined>(undefined);
// Rows with their run history unfolded.
const expanded = reactive(new Set<string>());

// "Start from" suggestions: provider-less recipes always show; provider-bound ones only when that capability
// is enabled.
const recipes = computed(() => {
    const enabled = new Set(capabilities.value.map((capability) => capability.config[`provider`]).filter((provider) => typeof provider === `string`));
    return AUTOMATION_RECIPES.filter((recipe) => recipe.provider === undefined || enabled.has(recipe.provider));
});

// The live sources the user can actually listen to: those whose provider is connected as a capability. Drives
// both whether the "Listen (live)" trigger shows and its Source picker.
const liveSources = computed(() => {
    const connected = new Set(capabilities.value.map((capability) => capability.config[`provider`]));
    return (Object.keys(LISTENER_SOURCES) as (keyof typeof LISTENER_SOURCES)[])
        .filter((provider) => connected.has(provider))
        .map((provider) => ({ provider, label: LISTENER_SOURCES[provider].label, logo: LISTENER_SOURCES[provider].logo }));
});

const effectiveCron = computed(() => cronOf(schedule));

// A croner instance without a callback never schedules — it's just a queryable pattern here.
// ponytail: preview uses the browser's timezone while the daemon fires in the sandbox's — same as the row's `next` display.
const cronPreview = computed<{ runs: number[] } | { error: string } | undefined>(() => {
    const cron = effectiveCron.value;
    if (form.kind !== `schedule` || cron === undefined) {
        return undefined;
    }
    try {
        const runs = new Cron(cron).nextRuns(3).map((date) => date.getTime());
        return runs.length > 0 ? { runs } : { error: `This schedule never fires.` };
    } catch {
        return { error: `Invalid cron expression.` };
    }
});

const canSubmit = computed(
    () =>
        NAME_RE.test(form.id) &&
        (form.kind !== `schedule` || (cronPreview.value !== undefined && `runs` in cronPreview.value)) &&
        form.prompt.trim() !== ``,
);
const topError = computed(() => actionError.value ?? listError.value);
const savedAutomation = computed(() => automations.value.find((automation) => automation.id === savedId.value));

// --- inline validation (touched-on-blur) ---
const touched = reactive(new Set<string>());
const shaking = ref(false);
const nameInput = ref<HTMLInputElement>();
const promptInput = ref<HTMLTextAreaElement>();
const markTouched = (key: string): void => {
    touched.add(key);
};

const nameError = computed<string | undefined>(() => {
    const trimmed = form.id.trim();
    if (trimmed.length === 0) return `Name is required.`;
    if (!NAME_RE.test(trimmed)) return `Use letters, digits, hyphens and underscores; must start with a letter or digit.`;
    return undefined;
});
const promptError = computed<string | undefined>(() => (form.prompt.trim() === `` ? `Prompt is required.` : undefined));

const touchAll = (): void => {
    touched.add(`name`);
    touched.add(`prompt`);
};

const toggleDay = (day: number): void => {
    const at = schedule.days.indexOf(day);
    if (at === -1) {
        schedule.days.push(day);
        return;
    }
    schedule.days.splice(at, 1);
};

const pickRecipe = (recipe: AutomationRecipe): void => {
    // Clicking the active card detaches the recipe but keeps whatever the user already edited.
    if (pickedRecipe.value === recipe) {
        pickedRecipe.value = undefined;
        return;
    }
    pickedRecipe.value = recipe;
    form.kind = recipe.trigger.kind;
    form.id = recipe.id;
    form.guard = recipe.guard ?? ``;
    form.prompt = recipe.prompt;
    // A prefilled guard lives under Advanced — open it so the user sees what the recipe set.
    advancedOpen.value = recipe.guard !== undefined;
    if (recipe.trigger.kind === `schedule`) {
        Object.assign(schedule, parseCron(recipe.trigger.cron));
    }
};

// Choosing a trigger by hand detaches a prefilled recipe once it no longer matches (the user's edits stay).
const setKind = (kind: typeof form.kind): void => {
    form.kind = kind;
    if (pickedRecipe.value && pickedRecipe.value.trigger.kind !== kind) {
        pickedRecipe.value = undefined;
    }
    if (kind !== `listener`) {
        return;
    }
    // Default to a connected live source, then give the prompt a running start without clobbering user text.
    if (!liveSources.value.some((source) => source.provider === form.provider)) {
        form.provider = liveSources.value[0]?.provider ?? `discord`;
    }
    if (form.prompt.trim() === ``) {
        form.prompt = LISTENER_SOURCES[form.provider].starterPrompt;
    }
};

const resetForm = (): void => {
    form.kind = `schedule`;
    form.id = ``;
    form.guard = ``;
    form.prompt = ``;
    form.model = ``;
    form.requireApproval = false;
    form.provider = `discord`;
    form.channelId = ``;
    form.eventType = undefined;
    form.mentioned = false;
    Object.assign(schedule, defaultSchedule());
    actionError.value = null;
    pickedRecipe.value = undefined;
    savedId.value = undefined;
    touched.clear();
    shaking.value = false;
    advancedOpen.value = false;
};

const submit = async (): Promise<void> => {
    touchAll();
    if (!canSubmit.value) {
        // Send the user to the first field to fix rather than only shaking the footer.
        const target = nameError.value !== undefined ? nameInput.value : promptError.value !== undefined ? promptInput.value : undefined;
        target?.focus();
        shaking.value = false;
        void nextTick(() => {
            shaking.value = true;
        });
        return;
    }
    if (save.isPending.value) {
        return;
    }
    const cron = form.kind === `schedule` ? effectiveCron.value : undefined;
    if (form.kind === `schedule` && cron === undefined) {
        return;
    }
    actionError.value = null;
    try {
        // An event trigger is sent without a token — the daemon mints the webhook's auth token on upsert.
        await save.mutateAsync({
            id: form.id,
            trigger:
                form.kind === `schedule`
                    ? { kind: `schedule`, cron: cron as string }
                    : form.kind === `event`
                      ? { kind: `event` }
                      : {
                            kind: `listener`,
                            provider: form.provider,
                            ...(form.eventType !== undefined ? { eventType: form.eventType } : {}),
                            ...(form.eventType === `message` && form.mentioned ? { mentioned: true } : {}),
                            ...(form.channelId.trim() !== `` ? { channelId: form.channelId.trim() } : {}),
                        },
            ...(form.guard.trim() !== `` ? { guard: form.guard.trim() } : {}),
            prompt: form.prompt,
            ...(form.model !== `` ? { model: form.model } : {}),
            ...(form.requireApproval ? { requireApproval: true } : {}),
            enabled: true,
        });
        // Event automations keep the dialog open: the refreshed list now carries the daemon-minted token, so the
        // done-state can show the webhook URL + where to paste it. Scheduled ones just close.
        if (form.kind === `event`) {
            savedId.value = form.id;
            return;
        }
        createOpen.value = false;
        resetForm();
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not save the automation.`;
    }
};

// The enabled toggle is a plain re-post of the automation with the flag flipped (upsert keeps the run history).
const toggle = async (automation: AutomationSummary, enabled: boolean): Promise<void> => {
    actionError.value = null;
    try {
        await save.mutateAsync({
            id: automation.id,
            trigger: automation.trigger,
            ...(automation.guard !== undefined ? { guard: automation.guard } : {}),
            prompt: automation.prompt,
            ...(automation.model !== undefined ? { model: automation.model } : {}),
            ...(automation.requireApproval !== undefined ? { requireApproval: automation.requireApproval } : {}),
            enabled,
        });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not update the automation.`;
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

// The event automation's webhook URL (with its token) for pasting into GitHub/Sentry/monitor settings.
const webhookUrl = (automation: AutomationSummary): string | undefined => {
    const base = daemonUrl.value;
    if (automation.trigger.kind !== `event` || !base) {
        return undefined;
    }
    return `${base}/automations/${encodeURIComponent(automation.id)}/fire?token=${automation.trigger.token ?? ``}`;
};

const formatAt = (at: number): string => new Date(at).toLocaleString();
// The prompt of the automation a pending approval belongs to, for a preview line (undefined if it was deleted).
const pendingPrompt = (automationId: string): string | undefined => automations.value.find((automation) => automation.id === automationId)?.prompt;
const outcomeLabel = (run: AutomationRun): string => (run.outcome === `skipped` ? `Skipped by guard` : run.outcome);
const outcomeVariant = (outcome: string): StatusVariant => (outcome === `completed` ? `success` : outcome === `error` ? `danger` : `warning`);
</script>

<template>
    <Page>
        <header class="mb-6">
            <h1 class="text-2xl font-semibold">Automations</h1>
            <p class="mt-1 text-sm text-muted">
                Wake your agent on a schedule, on a webhook, or instantly from live provider events. An optional guard command runs in your workspace
                first and decides whether each wake actually happens.
            </p>
        </header>

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

            <div v-if="automations.length === 0" :class="cmp.emptyState('py-6')">No automations yet — schedule your agent's first wake-up.</div>

            <div v-else class="flex flex-col gap-2">
                <div v-for="automation in automations" :key="automation.id" class="rounded-lg border border-line bg-canvas">
                    <div class="flex items-center justify-between gap-3 px-3 py-2">
                        <div class="min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="truncate font-medium text-content">{{ automation.id }}</span>
                                <span class="rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">{{
                                    automation.trigger.kind === "schedule"
                                        ? scheduleLabel(automation.trigger.cron)
                                        : automation.trigger.kind === "event"
                                          ? "event"
                                          : `live · ${automation.trigger.provider}${automation.trigger.eventType ? ` · ${automation.trigger.eventType}` : ``}${automation.trigger.mentioned ? ` · mentions` : ``}`
                                }}</span>
                                <CopyButton
                                    v-if="automation.trigger.kind === 'event'"
                                    :text="webhookUrl(automation) ?? ''"
                                    :aria-label="`Copy webhook URL for ${automation.id}`"
                                    v-tooltip.top="'Copy webhook URL'"
                                />
                                <Icon
                                    name="shield"
                                    v-if="automation.guard"
                                    v-tooltip.top="`Guarded: ${automation.guard}`"
                                    class="text-2xs text-subtle"
                                />
                                <Icon
                                    name="lock"
                                    v-if="automation.requireApproval"
                                    v-tooltip.top="'Requires your approval before running'"
                                    class="text-2xs text-subtle"
                                />
                            </div>
                            <p class="mt-0.5 truncate text-2xs text-subtle">{{ automation.prompt }}</p>
                        </div>
                        <div class="flex shrink-0 items-center gap-3">
                            <StatusBadge
                                v-if="automation.runs[0]"
                                :variant="outcomeVariant(automation.runs[0].outcome)"
                                :label="outcomeLabel(automation.runs[0])"
                                size="xs"
                                v-tooltip.top="automation.runs[0].detail"
                            />
                            <span v-if="automation.nextRun" class="text-2xs text-subtle">next {{ formatAt(automation.nextRun) }}</span>
                            <ToggleSwitch
                                :model-value="automation.enabled"
                                :aria-label="`Enable ${automation.id}`"
                                @update:model-value="toggle(automation, $event)"
                            />
                            <button
                                type="button"
                                class="text-muted hover:text-content"
                                :aria-label="`Run history for ${automation.id}`"
                                v-tooltip.top="'Run history'"
                                @click="toggleHistory(automation.id)"
                            >
                                <Icon name="history" class="text-sm" />
                            </button>
                            <button
                                type="button"
                                class="text-muted hover:text-danger"
                                :aria-label="`Delete ${automation.id}`"
                                v-tooltip.top="'Delete'"
                                @click="removeAutomation(automation.id)"
                            >
                                <Icon name="trash" class="text-sm" />
                            </button>
                        </div>
                    </div>

                    <div v-if="expanded.has(automation.id)" class="border-t border-line px-3 py-2">
                        <p v-if="automation.runs.length === 0" class="text-xs text-muted">No runs yet.</p>
                        <div v-else class="flex flex-col gap-1">
                            <div v-for="run in automation.runs" :key="run.at" class="flex items-baseline gap-2 text-2xs">
                                <span class="shrink-0 font-mono text-subtle">{{ formatAt(run.at) }}</span>
                                <StatusBadge :variant="outcomeVariant(run.outcome)" :label="outcomeLabel(run)" size="xs" />
                                <span v-if="run.detail" class="truncate text-subtle" v-tooltip.top="run.detail">{{ run.detail }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Card>

        <Dialog
            v-model:visible="createOpen"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '32rem' }"
            header="New automation"
            @hide="resetForm"
        >
            <form id="automation-form" v-if="savedId === undefined" class="flex flex-col gap-3" @submit.prevent="submit">
                <div v-if="recipes.length > 0" class="ui-field">
                    <span :class="cmp.sectionLabel()">Start from a template</span>
                    <p v-if="pickedRecipe" class="text-xs text-muted">
                        Prefilled from "{{ pickedRecipe.title }}" — edit anything below, or click the card again to clear.
                    </p>
                    <div class="flex flex-wrap gap-2">
                        <button
                            v-for="recipe in recipes"
                            :key="recipe.id"
                            type="button"
                            class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors"
                            :class="pickedRecipe === recipe ? CARD_SELECTED : CARD_IDLE"
                            :aria-pressed="pickedRecipe === recipe"
                            @click="pickRecipe(recipe)"
                        >
                            <img v-if="recipe.logo" :src="`https://cdn.simpleicons.org/${recipe.logo}`" class="h-4 w-4" alt="" />
                            <Icon name="bolt" v-else class="text-2xs" />
                            <span>
                                {{ recipe.title }}
                                <span v-if="recipe.note" class="text-2xs text-subtle">· {{ recipe.note }}</span>
                            </span>
                            <Icon name="check-circle" v-if="pickedRecipe === recipe" class="ml-auto" />
                        </button>
                    </div>
                </div>
                <label class="ui-field">
                    <span class="ui-field-label">Name</span>
                    <input
                        ref="nameInput"
                        v-model="form.id"
                        placeholder="morning-briefing"
                        :class="[cmp.input(), touched.has('name') && nameError ? 'ui-field-input-error' : '']"
                        @blur="markTouched('name')"
                    />
                    <span v-if="touched.has('name') && nameError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ nameError }}
                    </span>
                </label>
                <span :class="cmp.sectionLabel('mt-1')">Trigger</span>
                <div class="ui-field">
                    <div class="flex gap-2">
                        <button
                            type="button"
                            class="flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors"
                            :class="form.kind === 'schedule' ? CARD_SELECTED : CARD_IDLE"
                            :aria-pressed="form.kind === 'schedule'"
                            @click="setKind('schedule')"
                        >
                            <Icon name="clock" class="mr-1.5 text-2xs" />Schedule
                        </button>
                        <button
                            type="button"
                            class="flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors"
                            :class="form.kind === 'event' ? CARD_SELECTED : CARD_IDLE"
                            :aria-pressed="form.kind === 'event'"
                            @click="setKind('event')"
                        >
                            <Icon name="bolt" class="mr-1.5 text-2xs" />Event (webhook)
                        </button>
                        <button
                            v-if="liveSources.length > 0 || form.kind === 'listener'"
                            type="button"
                            class="flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors"
                            :class="form.kind === 'listener' ? CARD_SELECTED : CARD_IDLE"
                            :aria-pressed="form.kind === 'listener'"
                            @click="setKind('listener')"
                        >
                            <Icon name="wifi" class="mr-1.5 text-2xs" />Listen (live)
                        </button>
                    </div>
                </div>
                <template v-if="form.kind === 'listener'">
                    <div class="ui-field">
                        <span class="ui-field-label">Source</span>
                        <div class="flex flex-wrap gap-2">
                            <button
                                v-for="source in liveSources"
                                :key="source.provider"
                                type="button"
                                class="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors"
                                :class="form.provider === source.provider ? CARD_SELECTED : CARD_IDLE"
                                :aria-pressed="form.provider === source.provider"
                                @click="
                                    form.provider = source.provider;
                                    form.eventType = undefined;
                                "
                            >
                                <img :src="`https://cdn.simpleicons.org/${source.logo}`" class="h-4 w-4" alt="" />
                                {{ source.label }}
                                <Icon name="check-circle" v-if="form.provider === source.provider" class="ml-auto" />
                            </button>
                        </div>
                    </div>
                    <div class="ui-field">
                        <span class="ui-field-label">Events</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                type="button"
                                :class="[CHIP_BASE, form.eventType === undefined ? CHIP_SELECTED : CHIP_IDLE]"
                                :aria-pressed="form.eventType === undefined"
                                @click="form.eventType = undefined"
                            >
                                Any
                            </button>
                            <button
                                v-for="eventOption in LISTENER_SOURCES[form.provider].events"
                                :key="eventOption.value"
                                type="button"
                                :class="[CHIP_BASE, form.eventType === eventOption.value ? CHIP_SELECTED : CHIP_IDLE]"
                                :aria-pressed="form.eventType === eventOption.value"
                                @click="form.eventType = eventOption.value"
                            >
                                {{ eventOption.label }}
                            </button>
                        </div>
                        <label v-if="form.eventType === 'message'" class="flex items-center gap-2 text-xs text-muted">
                            <ToggleSwitch v-model="form.mentioned" aria-label="Only when the bot is mentioned" />
                            Only when the bot is mentioned (@mention or reply)
                        </label>
                    </div>
                    <label class="ui-field">
                        <span class="ui-field-label">Channel ID (optional)</span>
                        <input v-model="form.channelId" placeholder="all channels the bot can read" class="font-mono" :class="cmp.input()" />
                    </label>
                </template>
                <div v-if="form.kind === 'schedule'" class="ui-field">
                    <span class="ui-field-label">Repeats</span>
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            v-for="option in FREQ_OPTIONS"
                            :key="option.value"
                            type="button"
                            :class="[CHIP_BASE, schedule.freq === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                            :aria-pressed="schedule.freq === option.value"
                            @click="schedule.freq = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                    <div v-if="schedule.freq === 'weekly'" class="flex flex-wrap gap-1.5">
                        <button
                            v-for="day in DAY_OPTIONS"
                            :key="day.value"
                            type="button"
                            :class="[CHIP_BASE, schedule.days.includes(day.value) ? CHIP_SELECTED : CHIP_IDLE]"
                            :aria-pressed="schedule.days.includes(day.value)"
                            @click="toggleDay(day.value)"
                        >
                            {{ day.label }}
                        </button>
                    </div>
                    <label v-if="schedule.freq === 'minutes'" class="flex items-center gap-2 text-xs text-muted">
                        Every
                        <input v-model.number="schedule.everyMinutes" type="number" min="1" max="59" class="w-20" :class="cmp.input()" /> minutes
                    </label>
                    <label v-if="schedule.freq === 'monthly'" class="flex items-center gap-2 text-xs text-muted">
                        On day <input v-model.number="schedule.dayOfMonth" type="number" min="1" max="31" class="w-20" :class="cmp.input()" />
                    </label>
                    <label
                        v-if="schedule.freq === 'daily' || schedule.freq === 'weekly' || schedule.freq === 'monthly'"
                        class="flex items-center gap-2 text-xs text-muted"
                    >
                        At <input v-model="schedule.time" type="time" class="w-28" :class="cmp.input()" />
                    </label>
                    <input v-if="schedule.freq === 'custom'" v-model="schedule.cron" placeholder="0 9 * * 1-5" :class="cmp.input('font-mono')" />
                    <p v-if="schedule.freq === 'custom'" class="text-2xs text-subtle">Standard 5-field cron: minute hour day month weekday.</p>
                    <p v-if="schedule.freq === 'weekly' && schedule.days.length === 0" class="text-xs text-danger">Pick at least one day.</p>
                    <p v-if="cronPreview" class="text-xs" :class="'error' in cronPreview ? 'text-danger' : 'text-muted'">
                        <template v-if="'runs' in cronPreview">Next runs: {{ cronPreview.runs.map(formatAt).join(" · ") }}</template>
                        <template v-else>{{ cronPreview.error }}</template>
                    </p>
                </div>
                <p v-if="form.kind === 'event'" class="text-xs text-muted">
                    Wakes when an external system POSTs its webhook URL — shown after you create it.
                </p>
                <p v-else-if="form.kind === 'listener'" class="text-xs text-muted">
                    Fires instantly over {{ LISTENER_SOURCES[form.provider].label }}'s live connection when the selected events happen — "Any" wakes
                    on every kind.
                </p>
                <label class="ui-field mt-3">
                    <span class="ui-field-label">
                        Prompt
                        <span v-if="pickedRecipe" class="ml-1 text-2xs font-normal text-subtle">· starter from {{ pickedRecipe.title }}</span>
                    </span>
                    <textarea
                        ref="promptInput"
                        v-model="form.prompt"
                        rows="3"
                        placeholder="Check the inbox and summarize anything urgent."
                        :class="[cmp.input(), touched.has('prompt') && promptError ? 'ui-field-input-error' : '']"
                        @blur="markTouched('prompt')"
                    ></textarea>
                    <span v-if="touched.has('prompt') && promptError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ promptError }}
                    </span>
                </label>
                <div class="mt-1 flex flex-col gap-3">
                    <button
                        type="button"
                        class="flex w-full items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle"
                        :aria-expanded="advancedOpen"
                        @click="advancedOpen = !advancedOpen"
                    >
                        <Icon class="text-2xs" :name="advancedOpen ? 'chevron-down' : 'chevron-right'" />
                        <span>Advanced</span>
                        <span v-if="!advancedOpen" class="font-normal normal-case tracking-normal">· guard, model, approval</span>
                    </button>
                    <template v-if="advancedOpen">
                        <label class="ui-field">
                            <span class="ui-field-label">Guard command (optional)</span>
                            <input v-model="form.guard" placeholder="test -s .intentic/queue.json" class="font-mono" :class="cmp.input()" />
                            <p class="text-xs text-muted">
                                <template v-if="form.kind === 'event'">
                                    Runs before each wake with the payload in <span class="font-mono">$AUTOMATION_PAYLOAD</span>: exit 0 wakes the
                                    agent, anything else skips that run.
                                </template>
                                <template v-else-if="form.kind === 'listener'">
                                    Runs before each wake; batched events arrive as JSON lines in <span class="font-mono">$AUTOMATION_PAYLOAD</span>:
                                    exit 0 wakes the agent, anything else skips that run.
                                </template>
                                <template v-else
                                    >Runs in your workspace before each wake: exit 0 wakes the agent, anything else skips that run.</template
                                >
                            </p>
                        </label>
                        <div class="ui-field">
                            <span class="ui-field-label">Model</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    v-for="option in MODEL_OPTIONS"
                                    :key="option.value"
                                    type="button"
                                    :class="[CHIP_BASE, form.model === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                                    :aria-pressed="form.model === option.value"
                                    @click="form.model = option.value"
                                >
                                    {{ option.label }}
                                </button>
                            </div>
                        </div>
                        <label class="flex items-center gap-2 text-sm text-content">
                            <ToggleSwitch v-model="form.requireApproval" aria-label="Require my approval before running" />
                            Require my approval before it runs
                        </label>
                        <p v-if="form.requireApproval" class="-mt-1 text-2xs text-subtle">
                            Each time this fires, the agent waits — you approve or reject it under "Pending approvals" before it acts.
                        </p>
                    </template>
                </div>
            </form>
            <div v-else class="flex flex-col gap-3">
                <p class="text-sm text-content"><Icon name="check-circle" class="mr-1.5 text-success" />Automation created — wire up the webhook:</p>
                <div v-if="savedAutomation" class="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                    <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ webhookUrl(savedAutomation) }}</code>
                    <CopyButton :text="webhookUrl(savedAutomation) ?? ''" :aria-label="`Copy webhook URL for ${savedAutomation.id}`" />
                </div>
                <p class="text-xs text-muted">{{ pickedRecipe?.setup ?? `Any external system can wake this automation by POSTing this URL.` }}</p>
            </div>
            <template #footer>
                <div v-if="savedId === undefined" :class="['flex justify-end gap-2', shaking ? 'ui-shake' : '']" @animationend="shaking = false">
                    <Button label="Cancel" severity="secondary" :text="true" @click="createOpen = false" />
                    <Button type="submit" form="automation-form" label="Create" :loading="save.isPending.value">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
                <div v-else class="flex justify-end">
                    <Button label="Done" @click="createOpen = false" />
                </div>
            </template>
        </Dialog>
    </Page>
</template>
