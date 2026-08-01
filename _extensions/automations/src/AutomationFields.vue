<script setup lang="ts">
import { type CatalogOption, HARNESSES, ModelsSchema, modelsFor, PROVIDERS, WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import { cmp, Icon, ToggleSwitch } from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { formatAt } from "./cronSchedule";
import { host } from "./host";
import { LISTENER_SOURCES } from "./listenerSources";
import type { AutomationFormState, TriggerKind } from "./useAutomationForm";

/* EVERY FIELD OF AN AUTOMATION, once — rendered by the create dialog and by the row that edits an existing one.
 *
 * The two used to be one, because editing did not exist: an automation could only be made, never changed, and
 * the fields lived inside the dialog that made it. Adding an editor meant either a second copy of forty fields
 * or this. A copy would have drifted on the first Doorbell setting anyone added to one and not the other, and
 * the half that drifted would be the half nobody had open while they were changing the other.
 *
 * So the STATE is a composable (useAutomationForm) and the MARKUP is this component, and the two callers
 * differ only in their chrome: a modal with a template picker, or a panel inside the row. */

const props = defineProps<{
    state: AutomationFormState;
    /** The template this form was prefilled from, named beside the Prompt label. */
    recipeNote?: string;
    /** Editing an existing automation: its name is its identity and cannot be retyped here. */
    nameLocked?: boolean;
}>();

const { form, schedule, isDoorbell, liveSources, cronPreview, harnessChoosable, touched, markTouched, nameError, promptError, originsError } =
    props.state;

// Exposed so a submitting parent can send the user to the first field that needs fixing.
const nameInput = ref<HTMLInputElement>();
const promptInput = ref<HTMLTextAreaElement>();
defineExpose({ nameInput, promptInput });

// Small selectable pills (Repeats, Days, Model, Events, Source) — borderless; selection = a muted brand tint with readable brand text.
const CHIP_BASE = `rounded-md px-3 py-1.5 text-xs font-medium transition-colors`;
const CHIP_SELECTED = `bg-primary-600/15 text-link`;
const CHIP_IDLE = `text-muted hover:bg-overlay hover:text-content`;
// Larger tappable cards (Trigger) — idle sits on the overlay surface so it reads as a control without a border; selection tints and adds a brand ring.
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
const ACCESS_OPTIONS = [
    { value: `public`, label: `Anyone` },
    { value: `google`, label: `Google sign-in` },
] as const;
const ANTI_BOT_OPTIONS = [
    { value: `pow`, label: `Built-in check` },
    { value: `turnstile`, label: `Cloudflare Turnstile` },
    { value: `off`, label: `Off` },
] as const;

// The moments a chore can wake on. Worded as the moment rather than the event id — the id is wire vocabulary,
// and the two overlap enough (a clean turn auto-lands, firing both) that the difference has to read plainly.
const WORKSPACE_EVENTS = [
    { value: `turn.settled`, label: `A turn settles`, hint: `After every isolated agent turn — including the ones that errored or conflicted.` },
    { value: `agent.landed`, label: `Work lands`, hint: `Only when an agent's work actually reaches your workspace.` },
] as const;

// Guard/agent/approval fold away by default — revealed on demand or when a recipe prefilled a guard.
const advancedOpen = ref(form.guard !== ``);

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
const setAgent = (agent: typeof form.agent): void => {
    form.agent = agent;
    form.model = ``;
};
const setHarness = (harness: typeof form.harness): void => {
    form.harness = harness;
};

const toggleDay = (day: number): void => {
    const at = schedule.days.indexOf(day);
    if (at === -1) {
        schedule.days.push(day);
        return;
    }
    schedule.days.splice(at, 1);
};

// Choosing a trigger by hand tells the parent, so a prefilled template can detach once it no longer matches.
const emit = defineEmits<{ kindChange: [TriggerKind] }>();
const setKind = (kind: TriggerKind): void => {
    form.kind = kind;
    emit(`kindChange`, kind);
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
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- The name IS the automation's identity — the daemon upserts on it — so retyping it while editing
             would fork a second automation rather than rename this one. Absent once it exists; the row above
             is already showing it. -->
        <label v-if="!nameLocked" class="ui-field">
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
            <!-- A Doorbell is configured by WHERE it may be embedded and WHO may talk to it — the shared
                 listener fields (events, mention, channel) say nothing about a widget, so they fold away. -->
            <template v-if="isDoorbell">
                <label class="ui-field">
                    <span class="ui-field-label">Allowed sites</span>
                    <textarea
                        v-model="form.origins"
                        rows="2"
                        placeholder="https://example.com&#10;https://www.example.com"
                        class="font-mono"
                        :class="[cmp.input(), touched.has('origins') && originsError ? 'ui-field-input-error' : '']"
                        @blur="markTouched('origins')"
                    ></textarea>
                    <span v-if="touched.has('origins') && originsError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ originsError }}
                    </span>
                    <p v-else class="text-2xs text-subtle">
                        One per line. Only these sites may embed the chat — scheme and host, no path. www and the bare domain are different origins.
                    </p>
                </label>
                <div class="ui-field">
                    <span class="ui-field-label">Who can chat</span>
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            v-for="option in ACCESS_OPTIONS"
                            :key="option.value"
                            type="button"
                            :class="[CHIP_BASE, form.access === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                            :aria-pressed="form.access === option.value"
                            @click="form.access = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                </div>
                <label v-if="form.access === 'google'" class="ui-field">
                    <span class="ui-field-label">Google client ID</span>
                    <input v-model="form.googleClientId" placeholder="1234-abc.apps.googleusercontent.com" class="font-mono" :class="cmp.input()" />
                    <p class="text-2xs text-subtle">
                        Your site's own OAuth client — Google only issues a token to an origin you've authorized on it, so it can't be ours. Add each
                        allowed site above as an authorized JavaScript origin.
                    </p>
                </label>
                <div class="ui-field">
                    <span class="ui-field-label">Bot check</span>
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            v-for="option in ANTI_BOT_OPTIONS"
                            :key="option.value"
                            type="button"
                            :class="[CHIP_BASE, form.antiBot === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                            :aria-pressed="form.antiBot === option.value"
                            @click="form.antiBot = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                    <p class="text-2xs text-subtle">
                        <template v-if="form.antiBot === 'pow'">
                            Costs each new visitor about a second of their browser's time, and costs a bot the same per conversation. No accounts, no
                            keys.
                        </template>
                        <template v-else-if="form.antiBot === 'turnstile'"
                            >Invisible for most visitors. Needs a Cloudflare Turnstile widget.</template
                        >
                        <template v-else>The allowed-sites list and the rate limit are then the only gate.</template>
                    </p>
                </div>
                <template v-if="form.antiBot === 'turnstile'">
                    <label class="ui-field">
                        <span class="ui-field-label">Turnstile site key</span>
                        <input v-model="form.turnstileSiteKey" placeholder="0x4AAA…" class="font-mono" :class="cmp.input()" />
                    </label>
                    <label class="ui-field">
                        <span class="ui-field-label">Turnstile secret key</span>
                        <input v-model="form.turnstileSecret" type="password" placeholder="0x4AAA…" class="font-mono" :class="cmp.input()" />
                        <p class="text-2xs text-subtle">Stays in your sandbox — only the site key is ever sent to a visitor's browser.</p>
                    </label>
                </template>
                <label class="ui-field">
                    <span class="ui-field-label">Greeting (optional)</span>
                    <input v-model="form.greeting" placeholder="Hi! Ask me anything." :class="cmp.input()" />
                </label>
                <label class="ui-field">
                    <span class="ui-field-label">Daily message limit</span>
                    <input
                        v-model="form.dailyMessageMax"
                        type="number"
                        min="1"
                        :placeholder="String(WEBCHAT_DAILY_MAX_DEFAULT)"
                        :class="cmp.input()"
                    />
                    <p class="text-2xs text-subtle">
                        Every message runs an agent turn on your account. Left blank, a Doorbell stops answering after
                        {{ WEBCHAT_DAILY_MAX_DEFAULT }} messages a day and resumes the next day.
                    </p>
                </label>
            </template>
            <div v-if="!isDoorbell" class="ui-field">
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
            <label v-if="!isDoorbell" class="ui-field">
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
        <p v-else-if="isDoorbell" class="text-xs text-muted">
            Wakes when a visitor writes in the chat widget on your site. Each visitor's messages continue one conversation you can watch live and take
            over. The agent answers with a read-only toolbox — it can look things up, not change them.
        </p>
        <p v-else-if="form.kind === 'listener'" class="text-xs text-muted">
            Fires instantly over {{ LISTENER_SOURCES[form.provider].label }}'s live connection when the selected events happen — "Any" wakes on every
            kind.
        </p>
        <label class="ui-field mt-3">
            <span class="ui-field-label">
                Prompt
                <span v-if="recipeNote" class="ml-1 text-2xs font-normal text-subtle">· starter from {{ recipeNote }}</span>
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
                            Runs before each wake; batched events arrive as JSON lines in <span class="font-mono">$AUTOMATION_PAYLOAD</span>: exit 0
                            wakes the agent, anything else skips that run.
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
    </div>
</template>
