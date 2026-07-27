<script setup lang="ts">
import {
    type AgentHarness,
    type AgentProvider,
    type CatalogOption,
    HARNESSES,
    ModelsSchema,
    modelsFor,
    PROVIDERS,
    type WorkspaceEventKind,
} from "@intentic/sandbox-contract";
import { Button, cmp, CopyButton, Dialog, Icon, ToggleSwitch } from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { Cron } from "croner";
import { computed, nextTick, reactive, ref } from "vue";
import { cronOf, defaultSchedule, formatAt, parseCron } from "./cronSchedule";
import { host } from "./host";
import { type ListenerEventType, LISTENER_SOURCES } from "./listenerSources";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";
import { useAutomations, webhookUrl } from "./useAutomations";

/* The New-automation dialog: recipe templates → name → trigger (cron builder / webhook / live listener) →
 * prompt → Advanced (guard, provider+harness, model, approval). An event automation keeps the dialog open
 * after Create to show the daemon-minted webhook URL. Declarations run top-to-bottom at setup — keep the
 * order constants → data deps → form → catalog → UI state → derived → validation → methods. */

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
const DAY_OPTIONS = [
    { value: 1, label: `Mon` },
    { value: 2, label: `Tue` },
    { value: 3, label: `Wed` },
    { value: 4, label: `Thu` },
    { value: 5, label: `Fri` },
    { value: 6, label: `Sat` },
    { value: 0, label: `Sun` },
] as const;

// Shares useAutomations' cache with the list view — a save here invalidates and refreshes both.
const { automations, save } = useAutomations();
// Capability facts from the host — reactive because reading them inside a computed tracks the underlying store.
const capabilities = computed(() => host().workspace.capabilities());

const visible = defineModel<boolean>(`visible`, { default: false });

const form = reactive({
    kind: `schedule` as `schedule` | `event` | `listener` | `workspace`,
    id: ``,
    guard: ``,
    prompt: ``,
    agent: `claude` as AgentProvider,
    harness: `native` as AgentHarness,
    model: ``,
    requireApproval: false,
    provider: `discord` as keyof typeof LISTENER_SOURCES,
    channelId: ``,
    eventType: undefined as ListenerEventType | undefined,
    mentioned: false,
    // workspace triggers: which moment in this workspace's own work fires the chore, and an optional narrowing
    // to one repo of the change span.
    workspaceEvent: `turn.settled` as WorkspaceEventKind,
    repo: ``,
});

// The moments a chore can wake on. Worded as the moment rather than the event id — the id is wire vocabulary,
// and the two overlap enough (a clean turn auto-lands, firing both) that the difference has to read plainly.
const WORKSPACE_EVENTS: readonly { value: WorkspaceEventKind; label: string; hint: string }[] = [
    { value: `turn.settled`, label: `A turn settles`, hint: `After every isolated agent turn — including the ones that errored or conflicted.` },
    { value: `agent.landed`, label: `Work lands`, hint: `Only when an agent's work actually reaches your workspace.` },
];
const schedule = reactive(defaultSchedule());

// The picked provider's live model list — fetched lazily per provider, only while the form reads it. The
// catalog is the same under either harness (codex/grok run the same subscription ids via the translator), so
// it's keyed by provider alone.
const liveModels = useQuery({
    queryKey: computed(() => host().sandbox.key(`agent-models`, form.agent)),
    queryFn: async (): Promise<CatalogOption[]> =>
        ModelsSchema.parse(await host().sandbox.json(`/${form.agent}/models`)).models.map((model) => ({ value: model.id, label: model.label })),
    enabled: computed(() => host().sandbox.reachable()),
});

// The wake's model chips: "Default" (empty — the daemon resolves the provider's own default) plus the pinnable
// ids for the picked provider (with the static floor before the live load).
const modelOptions = computed<CatalogOption[]>(() => {
    const catalog = liveModels.data.value ?? modelsFor(form.agent);
    return [{ value: ``, label: `Default` }, ...catalog.filter((option) => option.value !== ``)];
});

// A provider switch invalidates a pinned model — back to that provider's default. A harness switch keeps it
// (the catalog is harness-independent).
const setAgent = (agent: AgentProvider): void => {
    form.agent = agent;
    form.model = ``;
};
const setHarness = (harness: AgentHarness): void => {
    form.harness = harness;
};
// Only codex/grok have both a native runtime and a routed one to switch between. Claude IS the Claude Code
// loop, and kimi/gemini only ever run on it — so none of the three has a harness to choose. Same rule as
// chat's picker (ChatModelPicker.harnessChoosable).
const harnessChoosable = computed(() => form.agent === `codex` || form.agent === `grok`);

// Guard/agent/approval fold away by default — revealed on demand or when a recipe prefills a guard.
const advancedOpen = ref(false);
const pickedRecipe = ref<AutomationRecipe | undefined>(undefined);
// Templates are a shortcut INTO the form, not a field of it, so they fold away too. A gallery of cards grew
// one card per connected capability and pushed Name below the fold; a disclosure costs one row whatever the
// recipe count is, and what it opens is filterable and scroll-capped rather than unboundedly tall.
const recipesOpen = ref(false);
const recipeFilter = ref(``);
const recipeFilterInput = ref<HTMLInputElement>();
// After creating an event automation the dialog stays open on this id to show the webhook URL + setup steps.
const savedId = ref<string | undefined>(undefined);
const submitError = ref<string | undefined>(undefined);

// "Start from" suggestions: provider-less recipes always show; provider-bound ones only when that capability
// is enabled.
const recipes = computed(() => {
    const enabled = new Set(capabilities.value.map((capability) => capability.config[`provider`]).filter((provider) => typeof provider === `string`));
    return AUTOMATION_RECIPES.filter((recipe) => recipe.provider === undefined || enabled.has(recipe.provider));
});

// The open picker's list, filtered and split in two: chores watch this workspace, everything else is fired
// from outside it. Two short labelled runs stay scannable where one flat pile of near-identical rows would
// not — "Push to repo" is two different templates once GitHub and GitLab are both connected.
const recipeGroups = computed(() => {
    const needle = recipeFilter.value.trim().toLowerCase();
    const matches = recipes.value.filter((recipe) =>
        [recipe.title, recipe.note, recipe.description, recipe.id, recipe.provider].some((field) => field?.toLowerCase().includes(needle)),
    );
    return [
        { label: `Code chores`, items: matches.filter((recipe) => recipe.chore === true) },
        { label: `Integrations`, items: matches.filter((recipe) => recipe.chore !== true) },
    ].filter((group) => group.items.length > 0);
});

// The live sources the user can actually listen to: those whose provider is connected as a capability. Drives
// both whether the "Listen (live)" trigger shows and its Source picker.
const liveSources = computed(() => {
    const connected = new Set(capabilities.value.map((capability) => capability.config[`provider`]));
    return (Object.keys(LISTENER_SOURCES) as (keyof typeof LISTENER_SOURCES)[])
        .filter((provider) => connected.has(provider))
        .map((provider) => Object.assign({ provider }, LISTENER_SOURCES[provider]));
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

// Opening the picker always starts from an empty filter and the caret in it — the list is long enough that
// typing two letters beats scrolling it.
const toggleRecipes = (): void => {
    recipesOpen.value = !recipesOpen.value;
    if (!recipesOpen.value) {
        return;
    }
    recipeFilter.value = ``;
    void nextTick(() => {
        recipeFilterInput.value?.focus();
    });
};

const pickRecipe = (recipe: AutomationRecipe): void => {
    pickedRecipe.value = recipe;
    recipesOpen.value = false;
    form.kind = recipe.trigger.kind;
    form.id = recipe.id;
    form.guard = recipe.guard ?? ``;
    form.prompt = recipe.prompt;
    // A prefilled guard lives under Advanced — open it so the user sees what the recipe set.
    advancedOpen.value = recipe.guard !== undefined;
    if (recipe.trigger.kind === `schedule`) {
        Object.assign(schedule, parseCron(recipe.trigger.cron));
    }
    if (recipe.trigger.kind === `listener`) {
        form.provider = recipe.trigger.provider;
        form.eventType = recipe.trigger.eventType;
    }
    if (recipe.trigger.kind === `workspace`) {
        form.workspaceEvent = recipe.trigger.event;
    }
};

// Enter in the filter takes the top match — and, because the picker sits inside the form, never submits it.
const pickFirstMatch = (): void => {
    const first = recipeGroups.value[0]?.items[0];
    if (first !== undefined) {
        pickRecipe(first);
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
    form.agent = `claude`;
    form.harness = `native`;
    form.model = ``;
    form.requireApproval = false;
    form.provider = `discord`;
    form.channelId = ``;
    form.eventType = undefined;
    form.mentioned = false;
    form.workspaceEvent = `turn.settled`;
    form.repo = ``;
    Object.assign(schedule, defaultSchedule());
    submitError.value = undefined;
    pickedRecipe.value = undefined;
    recipesOpen.value = false;
    recipeFilter.value = ``;
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
    submitError.value = undefined;
    try {
        // An event trigger is sent without a token — the daemon mints the webhook's auth token on upsert.
        await save.mutateAsync({
            id: form.id,
            trigger:
                form.kind === `schedule`
                    ? { kind: `schedule`, cron: cron as string }
                    : form.kind === `event`
                      ? { kind: `event` }
                      : form.kind === `workspace`
                        ? {
                              kind: `workspace`,
                              event: form.workspaceEvent,
                              ...(form.repo.trim() !== `` ? { repo: form.repo.trim() } : {}),
                          }
                        : {
                              kind: `listener`,
                              provider: form.provider,
                              ...(form.eventType !== undefined ? { eventType: form.eventType } : {}),
                              ...(form.eventType === `message` && form.mentioned ? { mentioned: true } : {}),
                              ...(form.channelId.trim() !== `` ? { channelId: form.channelId.trim() } : {}),
                          },
            ...(form.guard.trim() !== `` ? { guard: form.guard.trim() } : {}),
            prompt: form.prompt,
            // Defaults stay absent (schema: absent agent = claude, absent harness = native); claude never
            // carries a harness — the two loops are identical for it.
            ...(form.agent !== `claude` ? { agent: form.agent } : {}),
            ...(form.agent !== `claude` && form.harness !== `native` ? { harness: form.harness } : {}),
            ...(form.model !== `` ? { model: form.model } : {}),
            ...(form.requireApproval ? { requireApproval: true } : {}),
            // A workspace trigger is a chore by definition (nothing but this codebase can fire it). A chore on a
            // clock can't be told from an external poll by its trigger, so that one is carried from the recipe
            // it was started from.
            ...(form.kind === `workspace` || pickedRecipe.value?.chore === true ? { chore: true } : {}),
            enabled: true,
        });
        // Event automations keep the dialog open: the refreshed list now carries the daemon-minted token, so the
        // done-state can show the webhook URL + where to paste it. Scheduled ones just close.
        if (form.kind === `event`) {
            savedId.value = form.id;
            return;
        }
        visible.value = false;
        resetForm();
    } catch (err) {
        submitError.value = err instanceof Error ? err.message : `Could not save the automation.`;
    }
};
</script>

<template>
    <Dialog
        v-model:visible="visible"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :style="{ width: '32rem' }"
        header="New automation"
        @hide="resetForm"
    >
        <form id="automation-form" v-if="savedId === undefined" class="flex flex-col gap-3" @submit.prevent="submit">
            <div v-if="submitError" :class="cmp.alertDanger()">{{ submitError }}</div>
            <!-- One row until asked for: collapsed it is the invitation, open it is a filterable list, and once
                 something is picked it is that pick's summary. Same row throughout, so the height the templates
                 cost the form never depends on how many capabilities are connected. -->
            <div v-if="recipes.length > 0" class="ui-field">
                <div class="flex items-center rounded-md transition-colors" :class="pickedRecipe ? CARD_SELECTED : CARD_IDLE">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs"
                        :aria-expanded="recipesOpen"
                        @click="toggleRecipes"
                    >
                        <img v-if="pickedRecipe?.logo" :src="`https://cdn.simpleicons.org/${pickedRecipe.logo}`" class="h-4 w-4 shrink-0" alt="" />
                        <Icon v-else :name="pickedRecipe?.icon ?? 'bolt'" class="shrink-0 text-2xs" />
                        <span class="min-w-0 flex-1 truncate">
                            <template v-if="pickedRecipe">
                                {{ pickedRecipe.title }}
                                <span v-if="pickedRecipe.note" class="text-2xs text-subtle">· {{ pickedRecipe.note }}</span>
                            </template>
                            <template v-else>Start from a template</template>
                        </span>
                        <span v-if="!pickedRecipe" class="shrink-0 text-2xs text-subtle">{{ recipes.length }} available</span>
                        <Icon :name="recipesOpen ? 'chevron-down' : 'chevron-right'" class="shrink-0 text-2xs" />
                    </button>
                    <button
                        v-if="pickedRecipe"
                        type="button"
                        class="shrink-0 px-2.5 py-2 text-2xs text-muted transition-colors hover:text-content"
                        aria-label="Clear template"
                        @click="pickedRecipe = undefined"
                    >
                        <Icon name="times" />
                    </button>
                </div>
                <p v-if="pickedRecipe" class="text-2xs text-subtle">Prefilled below — edit anything, or clear it to start from scratch.</p>
                <div v-if="recipesOpen" class="flex flex-col gap-1.5 rounded-md border border-line bg-canvas p-1.5">
                    <input
                        ref="recipeFilterInput"
                        v-model="recipeFilter"
                        placeholder="Filter templates…"
                        :class="cmp.input('px-2 py-1 text-xs')"
                        @keydown.enter.prevent="pickFirstMatch"
                        @keydown.escape.stop.prevent="recipesOpen = false"
                    />
                    <div class="scrollbar-thin flex max-h-56 flex-col overflow-auto">
                        <template v-for="group in recipeGroups" :key="group.label">
                            <span :class="cmp.sectionLabel('px-1.5 pb-1 pt-2 text-2xs first:pt-0.5')">{{ group.label }}</span>
                            <button
                                v-for="recipe in group.items"
                                :key="recipe.id"
                                type="button"
                                class="flex items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-overlay"
                                :class="pickedRecipe === recipe ? 'text-link' : 'text-muted hover:text-content'"
                                :aria-pressed="pickedRecipe === recipe"
                                @click="pickRecipe(recipe)"
                            >
                                <img v-if="recipe.logo" :src="`https://cdn.simpleicons.org/${recipe.logo}`" class="h-4 w-4 shrink-0" alt="" />
                                <Icon v-else :name="recipe.icon ?? 'bolt'" class="shrink-0 text-2xs" />
                                <span class="min-w-0 flex-1 truncate">{{ recipe.title }}</span>
                                <span v-if="recipe.note" class="shrink-0 text-2xs text-subtle">{{ recipe.note }}</span>
                                <Icon name="check-circle" v-if="pickedRecipe === recipe" class="shrink-0 text-2xs" />
                            </button>
                        </template>
                        <p v-if="recipeGroups.length === 0" class="px-1.5 py-2 text-2xs text-subtle">No template matches.</p>
                    </div>
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
                    <button
                        type="button"
                        class="flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors"
                        :class="form.kind === 'workspace' ? CARD_SELECTED : CARD_IDLE"
                        :aria-pressed="form.kind === 'workspace'"
                        @click="setKind('workspace')"
                    >
                        <Icon name="eye" class="mr-1.5 text-2xs" />This workspace
                    </button>
                </div>
            </div>
            <!-- A chore's trigger: which moment in the fleet's own work wakes it, and optionally one repo of the
                 change to care about. No token and no URL — nothing outside the sandbox can fire this. -->
            <template v-if="form.kind === 'workspace'">
                <div class="ui-field">
                    <span class="ui-field-label">Wake when</span>
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            v-for="option in WORKSPACE_EVENTS"
                            :key="option.value"
                            type="button"
                            :class="[CHIP_BASE, form.workspaceEvent === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                            :aria-pressed="form.workspaceEvent === option.value"
                            @click="form.workspaceEvent = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                    <span class="text-2xs text-subtle">
                        {{ WORKSPACE_EVENTS.find((option) => option.value === form.workspaceEvent)?.hint }}
                    </span>
                </div>
                <label class="ui-field">
                    <span class="ui-field-label">Only this repo (optional)</span>
                    <input v-model="form.repo" placeholder="every repo the change touched" class="font-mono" :class="cmp.input()" />
                </label>
            </template>
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
                            <img v-if="source.logo" :src="`https://cdn.simpleicons.org/${source.logo}`" class="h-4 w-4" alt="" />
                            <Icon v-else :name="source.icon ?? 'bolt'" class="text-2xs" />
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
                        <ToggleSwitch v-model="form.mentioned" :aria-label="LISTENER_SOURCES[form.provider].mentionLabel" />
                        {{ LISTENER_SOURCES[form.provider].mentionLabel }}
                    </label>
                </div>
                <label class="ui-field">
                    <span class="ui-field-label">{{ LISTENER_SOURCES[form.provider].channel.label }}</span>
                    <input
                        v-model="form.channelId"
                        :placeholder="LISTENER_SOURCES[form.provider].channel.placeholder"
                        class="font-mono"
                        :class="cmp.input()"
                    />
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
                Fires instantly over {{ LISTENER_SOURCES[form.provider].label }}'s live connection when the selected events happen — "Any" wakes on
                every kind.
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
                    <span v-if="!advancedOpen" class="font-normal normal-case tracking-normal">· guard, provider, model, approval</span>
                </button>
                <template v-if="advancedOpen">
                    <label class="ui-field">
                        <span class="ui-field-label">Guard command (optional)</span>
                        <input v-model="form.guard" placeholder="test -s .intentic/queue.json" class="font-mono" :class="cmp.input()" />
                        <p class="text-xs text-muted">
                            <template v-if="form.kind === 'event'">
                                Runs before each wake with the payload in <span class="font-mono">$AUTOMATION_PAYLOAD</span>: exit 0 wakes the agent,
                                anything else skips that run.
                            </template>
                            <template v-else-if="form.kind === 'listener'">
                                Runs before each wake; batched events arrive as JSON lines in <span class="font-mono">$AUTOMATION_PAYLOAD</span>: exit
                                0 wakes the agent, anything else skips that run.
                            </template>
                            <template v-else>Runs in your workspace before each wake: exit 0 wakes the agent, anything else skips that run.</template>
                        </p>
                    </label>
                    <div class="ui-field">
                        <span class="ui-field-label">Provider</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="option in PROVIDERS"
                                :key="option.value"
                                type="button"
                                :class="[CHIP_BASE, form.agent === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                                :aria-pressed="form.agent === option.value"
                                @click="setAgent(option.value)"
                            >
                                {{ option.label }}
                            </button>
                        </div>
                    </div>
                    <!-- Harness (the agentic loop), orthogonal to the provider — only codex/grok can switch;
                         claude/kimi/gemini always run the Claude Code loop. Same semantics as chat's picker. -->
                    <div v-if="harnessChoosable" class="ui-field">
                        <span class="ui-field-label">Harness</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="option in HARNESSES"
                                :key="option.value"
                                type="button"
                                :class="[CHIP_BASE, form.harness === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                                :aria-pressed="form.harness === option.value"
                                @click="setHarness(option.value)"
                            >
                                {{ option.label }}
                            </button>
                        </div>
                        <p v-if="form.harness === 'claude-code'" class="text-xs text-muted">
                            Runs this model through the Claude Code harness on your
                            {{ form.agent === "codex" ? "ChatGPT" : "SuperGrok" }} subscription (connect it in Sandbox ▸ Agent).
                        </p>
                    </div>
                    <div class="ui-field">
                        <span class="ui-field-label">Model</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="option in modelOptions"
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
                <Button label="Cancel" severity="secondary" :text="true" @click="visible = false" />
                <Button type="submit" form="automation-form" label="Create" :loading="save.isPending.value">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
            <div v-else class="flex justify-end">
                <Button label="Done" @click="visible = false" />
            </div>
        </template>
    </Dialog>
</template>
