<script setup lang="ts">
import {
    type CatalogOption,
    HARNESSES,
    ModelsSchema,
    modelsFor,
    OauthAccountListSchema,
    PROVIDERS,
    WEBCHAT_DAILY_MAX_DEFAULT,
} from "@intentic/sandbox-contract";
import { cmp, formatDateTime, Icon, ToggleSwitch } from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { host } from "./host";
import { LISTENER_SOURCES } from "./listenerSources";
import { useCiDelivery } from "./useCiDelivery";
import type { AutomationFormState, TriggerKind } from "./useAutomationForm";

/* EVERY FIELD OF AN AUTOMATION, once — rendered by the composer that creates one and by the row that edits one.
 *
 * The two used to be one, because editing did not exist: an automation could only be made, never changed, and
 * the fields lived inside the dialog that made it. Adding an editor meant either a second copy of forty fields
 * or this. A copy would have drifted on the first Doorbell setting anyone added to one and not the other, and
 * the half that drifted would be the half nobody had open while they were changing the other.
 *
 * So the STATE is a composable (useAutomationForm) and the MARKUP is this component, and the two callers differ
 * only in their chrome: a panel at the top of the list with a template gallery, or a panel inside the row.
 *
 * THEY ALSO AGREE ON WIDTH NOW, which is what let the fields below become two columns. While creating happened
 * in a 44rem modal they did not: the same markup rendered at two measures, every fold tuned for the narrower
 * one, and a Doorbell — eight fields before the Prompt is even reached — was a column you scrolled twice. */

const props = defineProps<{
    state: AutomationFormState;
    /** The template this form was prefilled from, named beside the Prompt label. */
    recipeNote?: string;
    /** Editing an existing automation: its name is its identity and cannot be retyped here. */
    nameLocked?: boolean;
}>();

const {
    form,
    schedule,
    isDoorbell,
    branchField,
    liveSources,
    cronPreview,
    harnessChoosable,
    starterPrompt,
    staleStarter,
    applyStarter,
    touched,
    markTouched,
    nameError,
    promptError,
    originsError,
} = props.state;

// A CI trigger's delivery path — whether this will fire instantly, be polled, or never fire at all. Only
// fetched while a CI trigger is on screen. See useCiDelivery.
const isCi = computed(() => form.kind === `listener` && form.provider === `ci`);
const { delivery } = useCiDelivery(
    isCi,
    computed(() => form.channelId),
);
const DELIVERY_TONE = {
    ok: `text-muted`,
    polling: `text-warning`,
    none: `text-danger`,
} as const;
const DELIVERY_ICON = {
    ok: `check-circle`,
    polling: `clock`,
    none: `exclamation-triangle`,
} as const;

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

/* The picked provider's connected ACCOUNTS, read the same way and on the same seam as its models.
 *
 * A sandbox holds several side by side, and an automation is the surface that most needs to say which one:
 * nobody is watching when it fires, so a first account that is out of headroom — or whose organization has
 * turned the plan off — is an automation that errors every time until someone reads the row. A provider whose
 * turns authenticate through the bundled translator has no accounts to choose between and the picker stays
 * hidden for it, which is also what an unreachable daemon looks like. */
const liveAccounts = useQuery({
    queryKey: computed(() => host().sandbox.key(`agent-accounts`, form.agent)),
    queryFn: async (): Promise<CatalogOption[]> =>
        OauthAccountListSchema.parse(await host().sandbox.json(`/${form.agent}/accounts`)).accounts.map((account) => ({
            value: account.id,
            // The sign-in identity is what the owner recognises — the label is "Claude" on an account nobody
            // renamed, which says nothing when three of them are listed together.
            label: account.email ?? account.label,
        })),
    enabled: computed(() => host().sandbox.reachable()),
});

const accountOptions = computed<CatalogOption[]>(() => [{ value: ``, label: `Default` }, ...(liveAccounts.data.value ?? [])]);

// A provider switch invalidates a pinned model AND a pinned account — an account id is one provider's store
// key, so carrying it across would pin the wake to an account that provider does not have. A harness switch
// keeps both (the catalog and the credential store are harness-independent).
const setAgent = (agent: typeof form.agent): void => {
    form.agent = agent;
    form.model = ``;
    form.account = ``;
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

/* The two halves of picking a trigger. Neither touches the Prompt: the starter follows the trigger in the form
 * state itself (useAutomationForm), so it cannot be seeded in one of these and forgotten in the other — which is
 * exactly what left a CI automation carrying Discord's briefing. */
const setKind = (kind: TriggerKind): void => {
    form.kind = kind;
    // A live trigger needs a source that is actually connected; the remembered one may not be.
    if (kind === `listener` && !liveSources.value.some((source) => source.provider === form.provider)) {
        form.provider = liveSources.value[0]?.provider ?? `discord`;
    }
};
// Switching source changes what an event IS, so the event filter cannot carry over — `pipeline_failed` is not a
// thing Discord sends, and a filter no source matches is a row that never fires.
const setProvider = (provider: keyof typeof LISTENER_SOURCES): void => {
    form.provider = provider;
    form.eventType = undefined;
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
        <!-- THE TWO QUESTIONS AN AUTOMATION ANSWERS, SIDE BY SIDE — and now SAYING SO. What fires it, and what
             it then does. They used to be one column forty fields tall, because the form lived in a 44rem modal
             and a column was the only thing that fit — the Doorbell branch alone is eight fields, and reaching
             the Prompt meant scrolling past every one of them without ever seeing the two halves together.
             Both callers hand this component the whole page (72rem), so the split is the same in the create
             panel and in the row's editor — one layout, not two to keep honest. It stacks back to one column
             below `md`, where a second column would be two cramped ones.
             The split was a bare grid first, and a bare grid is what made it read as ragged rather than as two
             halves: nothing named the columns, so a short "When" beside a tall "Then" looked like a layout that
             had failed rather than one question that happens to be shorter than the other. A heading each and a
             rule between them is what turns the same two columns into a sentence — WHEN this happens, THEN do
             that — and the rule is also what makes their ends read as deliberate. -->
        <div class="grid items-stretch gap-x-0 gap-y-5 md:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-3 md:pr-5">
                <div class="flex items-baseline gap-2">
                    <span :class="cmp.sectionLabel()">When</span>
                    <span class="text-2xs text-subtle">what wakes the agent</span>
                </div>
                <!-- The trigger picker LIVES IN ITS OWN HALF, at the head of the fields it governs, rather than
                     spanning both columns above them. Everything below it in this column exists because of the
                     button that is lit; the Prompt beside it does not change when the picker does. Two per row
                     rather than four across: at half the width the four cards are bigger targets than they were
                     spread over the whole panel, and they no longer read as a toolbar for the entire form. -->
                <div class="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        class="rounded-md px-3 py-2 text-xs font-medium transition-colors"
                        :class="form.kind === 'schedule' ? CARD_SELECTED : CARD_IDLE"
                        :aria-pressed="form.kind === 'schedule'"
                        @click="setKind('schedule')"
                    >
                        <Icon name="clock" class="mr-1.5 text-2xs" />Schedule
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-3 py-2 text-xs font-medium transition-colors"
                        :class="form.kind === 'event' ? CARD_SELECTED : CARD_IDLE"
                        :aria-pressed="form.kind === 'event'"
                        @click="setKind('event')"
                    >
                        <Icon name="bolt" class="mr-1.5 text-2xs" />Event (webhook)
                    </button>
                    <button
                        v-if="liveSources.length > 0 || form.kind === 'listener'"
                        type="button"
                        class="rounded-md px-3 py-2 text-xs font-medium transition-colors"
                        :class="form.kind === 'listener' ? CARD_SELECTED : CARD_IDLE"
                        :aria-pressed="form.kind === 'listener'"
                        @click="setKind('listener')"
                    >
                        <Icon name="wifi" class="mr-1.5 text-2xs" />Listen (live)
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-3 py-2 text-xs font-medium transition-colors"
                        :class="form.kind === 'workspace' ? CARD_SELECTED : CARD_IDLE"
                        :aria-pressed="form.kind === 'workspace'"
                        @click="setKind('workspace')"
                    >
                        <Icon name="eye" class="mr-1.5 text-2xs" />This workspace
                    </button>
                </div>
                <!-- A chore's trigger: which moment in the fleet's own work wakes it, and optionally one repo of
                     the change to care about. No token and no URL — nothing outside the sandbox can fire this. -->
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
                                @click="setProvider(source.provider)"
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
                                One per line. Only these sites may embed the chat — scheme and host, no path. www and the bare domain are different
                                origins.
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
                            <input
                                v-model="form.googleClientId"
                                placeholder="1234-abc.apps.googleusercontent.com"
                                class="font-mono"
                                :class="cmp.input()"
                            />
                            <p class="text-2xs text-subtle">
                                Your site's own OAuth client — Google only issues a token to an origin you've authorized on it, so it can't be ours.
                                Add each allowed site above as an authorized JavaScript origin.
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
                                    Costs each new visitor about a second of their browser's time, and costs a bot the same per conversation. No
                                    accounts, no keys.
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
                    <!-- The second narrowing axis, for the one source that has one: CI's branch. Without it, "wake me
                 when CI fails" means every agent's branch as well as the one that ships. -->
                    <label v-if="branchField" class="ui-field">
                        <span class="ui-field-label">{{ branchField.label }}</span>
                        <input v-model="form.branch" :placeholder="branchField.placeholder" class="font-mono" :class="cmp.input()" />
                        <p class="text-2xs text-subtle">{{ branchField.hint }}</p>
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
                        <!-- Wide enough for a 12-hour locale: `w-28` fit "09:00" and the picker glyph, so every
                             en-US browser rendered "09:00 A" with the M clipped off. -->
                        At <input v-model="schedule.time" type="time" class="w-36" :class="cmp.input()" />
                    </label>
                    <input v-if="schedule.freq === 'custom'" v-model="schedule.cron" placeholder="0 9 * * 1-5" :class="cmp.input('font-mono')" />
                    <p v-if="schedule.freq === 'custom'" class="text-2xs text-subtle">Standard 5-field cron: minute hour day month weekday.</p>
                    <p v-if="schedule.freq === 'weekly' && schedule.days.length === 0" class="text-xs text-danger">Pick at least one day.</p>
                    <p v-if="cronPreview" class="text-xs" :class="'error' in cronPreview ? 'text-danger' : 'text-muted'">
                        <template v-if="'runs' in cronPreview">Next runs: {{ cronPreview.runs.map(formatDateTime).join(" · ") }}</template>
                        <template v-else>{{ cronPreview.error }}</template>
                    </p>
                </div>
                <p v-if="form.kind === 'event'" class="text-xs text-muted">
                    Wakes when an external system POSTs its webhook URL — shown after you create it.
                </p>
                <p v-else-if="isDoorbell" class="text-xs text-muted">
                    Wakes when a visitor writes in the chat widget on your site. Each visitor's messages continue one conversation you can watch live
                    and take over. The agent answers with a read-only toolbox — it can look things up, not change them.
                </p>
                <!-- CI is the one source with no gateway holding a connection open: its events arrive by provider
             webhook, or by polling when that webhook could not be registered. Which of the two — or neither —
             is the difference between a row that works and a row that silently never fires, so it is stated
             here rather than left to be discovered from an empty run history. -->
                <template v-else-if="isCi">
                    <p v-if="delivery" class="flex items-start gap-1.5 text-xs" :class="DELIVERY_TONE[delivery.state]">
                        <Icon :name="DELIVERY_ICON[delivery.state]" class="mt-0.5 shrink-0 text-2xs" />
                        <span>
                            {{ delivery.summary }}
                            <span v-if="delivery.detail" class="mt-1 block text-2xs text-subtle">{{ delivery.detail }}</span>
                        </span>
                    </p>
                </template>
                <p v-else-if="form.kind === 'listener'" class="text-xs text-muted">
                    Fires instantly over {{ LISTENER_SOURCES[form.provider].label }}'s live connection when the selected events happen — "Any" wakes
                    on every kind.
                </p>
            </div>

            <div class="flex min-w-0 flex-col gap-3 md:border-l md:border-line md:pl-5">
                <div class="flex items-baseline gap-2">
                    <span :class="cmp.sectionLabel()">Then</span>
                    <span class="text-2xs text-subtle">what it wakes with</span>
                </div>
                <!-- The one field nothing validates, and the one that has to agree with the trigger beside it: a
             briefing about Discord messages on a CI trigger is a wake that reads a payload it was never told
             about. So the label says whose starting point is in the box while it is still a starting point, and
             a starter left over from another source is named with the swap beside it. -->
                <label class="ui-field flex-1">
                    <span class="ui-field-label">
                        Prompt
                        <span v-if="recipeNote" class="ml-1 text-2xs font-normal text-subtle">· starter from {{ recipeNote }}</span>
                        <span v-else-if="starterPrompt && form.prompt === starterPrompt" class="ml-1 text-2xs font-normal text-subtle">
                            · {{ LISTENER_SOURCES[form.provider].label }} starter — edit it, or leave it and it follows the source
                        </span>
                    </span>
                    <!-- IT TAKES WHATEVER HEIGHT THE TRIGGER LEAVES, rather than a fixed six rows. It is the
                         longest thing on the form — a listener's starter is a paragraph describing a payload —
                         and it is the field the whole automation turns on, yet it was the one field showing part
                         of itself behind a scrollbar. Six rows was also the number that made a Doorbell (eight
                         trigger fields beside it) end this column 350px short of the other, which is the dead
                         rectangle that made the panel look broken. Growing to meet the trigger column fixes both
                         at once: the prompt gets exactly the room the branch was wasting. -->
                    <textarea
                        ref="promptInput"
                        v-model="form.prompt"
                        placeholder="Check the inbox and summarize anything urgent."
                        :class="[cmp.input('min-h-32 flex-1'), touched.has('prompt') && promptError ? 'ui-field-input-error' : '']"
                        @blur="markTouched('prompt')"
                    ></textarea>
                    <span v-if="touched.has('prompt') && promptError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ promptError }}
                    </span>
                    <p v-else-if="staleStarter" class="flex flex-wrap items-baseline gap-x-1.5 text-2xs text-warning">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        <span
                            >This is {{ staleStarter.label }}'s starter, but {{ LISTENER_SOURCES[form.provider].label }} sends a different
                            payload.</span
                        >
                        <button type="button" class="cursor-pointer text-link hover:underline" @click="applyStarter">
                            Use the {{ LISTENER_SOURCES[form.provider].label }} starter
                        </button>
                    </p>
                </label>
            </div>
        </div>

        <!-- ADVANCED BELONGS TO NEITHER HALF, so it sits under both rather than in one of them.
             It lived at the foot of the "Then" column, and being there made it the one control that could
             unbalance the layout by being used: opening it grew that column by 400px and left the trigger
             column beside it ending in a void — the exact defect the two panes were rebuilt to remove, only
             mirrored. It is also simply the wrong half. A guard decides whether a wake happens at all, and the
             provider, harness and model are what the wake RUNS ON; neither is "what it wakes with", and neither
             changes when the trigger does. Full width also fits them properly: four rows of chips that wrapped
             two-per-line in half a panel now sit one row each.
             `mt-2` and no rule: at the container's own gap the collapsed line sat 18px under "Next runs" and
             read as the last field of the trigger column. A border would separate it, but the footer above the
             buttons already draws one, and two rules forty pixels apart is a louder answer than the question. -->
        <div class="mt-2 flex flex-col gap-3">
            <button
                type="button"
                class="flex w-fit cursor-pointer items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle transition-colors hover:text-muted"
                :aria-expanded="advancedOpen"
                @click="advancedOpen = !advancedOpen"
            >
                <Icon class="text-2xs" :name="advancedOpen ? 'chevron-down' : 'chevron-right'" />
                <span>Advanced</span>
                <span v-if="!advancedOpen" class="font-normal normal-case tracking-normal">· guard, provider, account, model, approval</span>
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
                <!-- Which connected account pays for — and runs — the wake. Hidden when the provider has none to
                     choose between (a translator-routed subscription, or a daemon we haven't reached yet). -->
                <div v-if="accountOptions.length > 1" class="ui-field">
                    <span class="ui-field-label">Account</span>
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            v-for="option in accountOptions"
                            :key="option.value"
                            type="button"
                            :class="[CHIP_BASE, form.account === option.value ? CHIP_SELECTED : CHIP_IDLE]"
                            :aria-pressed="form.account === option.value"
                            @click="form.account = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                    <p class="text-xs text-muted">
                        Left on Default, this runs on whichever account comes first — so it starts failing when that one runs out of
                        headroom or its plan is switched off. Pin one to keep this automation on an account you know can answer.
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
                <!-- The one place this caveat lands where it changes a decision. It is in the Doorbell docs, but
                     nobody reads those while flipping a toggle, and a support chat that can never answer is not
                     what "require my approval" sounds like. -->
                <p v-if="form.requireApproval && isDoorbell" class="-mt-1 text-2xs text-warning">
                    On a Doorbell this means visitors never get an answer in the widget: they see "a human will review this", and the
                    approved reply lands on the conversation for you to handle, not back on their chat.
                </p>
            </template>
        </div>
    </div>
</template>
