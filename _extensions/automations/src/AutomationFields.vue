<script setup lang="ts">
import type { ModelPin } from "@intentic/sandbox-contract";
import { WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import {
    ui,
    formatDateTime,
    Icon,
    type IconName,
    Picker,
    type PickerOption,
    ProseField,
    SegmentedControl,
    ToggleSwitch,
    vAction,
} from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { glyph } from "./catalog";
import { host } from "./host";
import { useCiDelivery } from "./useCiDelivery";
import type { AutomationFormState, TriggerKind } from "./useAutomationForm";

// Every field of an automation, rendered once by both the composer that creates one and the row that edits one; the
// shared state lives in useAutomationForm. Three full-width steps (When, Then, Runs as) in a label rail, each sized to
// its own content, rather than two columns forcing every step into the same box.

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
    isFrontDesk,
    listenerSource,
    branchField,
    liveSources,
    visibleSources,
    cronPreview,
    starterPrompt,
    staleStarter,
    applyStarter,
    touched,
    markTouched,
    nameError,
    promptError,
    originsError,
    modelsError,
} = props.state;

// Personas this sandbox can wear, for the picker below; read here since the list is the same for every automation.
// Names only: a card's connection status belongs on the Personas page, not here.
const personaList = useQuery({
    queryKey: host().sandbox.key(`personas`),
    queryFn: () => host().sandbox.rpc.personas.list(),
    enabled: computed(() => host().sandbox.reachable()),
});
const personas = computed<readonly PickerOption[]>(() =>
    (personaList.data.value?.personas ?? [])
        // `face` draws the same derived character used on the Personas page and in chat, so picking who an automation
        // speaks as is the same act of recognition everywhere.
        .map((persona) => ({ value: persona.id, label: persona.label ?? persona.id, face: persona }))
        // Ordered, because a picker whose rows arrive in the file's order is a list you have to read twice.
        .toSorted((a, b) => a.label.localeCompare(b.label)),
);

// Blank means different things: a Front Desk fills it in as read-only at save, elsewhere it's nobody. A pinned persona
// whose card is gone still gets a face, greyed, not a glyph, so it reads as gone, not unpinned.
const personaOptions = computed<readonly PickerOption[]>(() => [
    isFrontDesk.value
        ? { value: ``, label: `Front desk`, description: `read-only`, icon: `globe` as const }
        : { value: ``, label: `Nobody`, description: `no accounts`, icon: `circle` as const },
    ...personas.value,
    ...(form.actsAs !== `` && !personas.value.some((persona) => persona.value === form.actsAs)
        ? [{ value: form.actsAs, label: form.actsAs, description: `no longer exists`, face: { id: form.actsAs }, disabled: true }]
        : []),
]);

// CI's delivery path: instant, polled, or never; fetched only while a CI trigger is on screen.
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

// Exposed so a submitting parent can focus the first invalid field; `promptInput` reaches inside `<ProseField>` to the
// actual element, not the component.
const nameInput = ref<HTMLInputElement>();
const promptField = ref<InstanceType<typeof ProseField>>();
const promptInput = computed(() => promptField.value?.field);
defineExpose({ nameInput, promptInput });

// The app's segmented control, not four hand-drawn cards, so the loudest thing in the form isn't the trigger-kind
// question. Each keeps its glyph, the same one the list outside this form uses for the row.
const TRIGGER_TABS = computed<readonly { value: TriggerKind; label: string; icon: IconName }[]>(() => [
    { value: `schedule`, label: `Schedule`, icon: `clock` },
    { value: `event`, label: `Webhook`, icon: `bolt` },
    // Needs a connected gateway; an already-Live automation keeps it listed so its editor can't re-point it.
    ...(liveSources.value.length > 0 || form.kind === `listener` ? [{ value: `listener` as const, label: `Live`, icon: `wifi` as const }] : []),
    { value: `workspace`, label: `Workspace`, icon: `eye` },
]);

// One caption sentence per trigger kind, shown under the picker instead of a label with its own gloss.
const KIND_CAPTION: Record<TriggerKind, string> = {
    schedule: `On a clock, in this sandbox's own timezone.`,
    event: `When any outside system POSTs to its webhook URL, which is shown to you once it exists.`,
    listener: `The moment a connected service sends something. Nothing is polled: a gateway holds the connection open.`,
    workspace: `On a moment in this workspace's own work. No token and no URL: nothing outside the sandbox can fire it.`,
};
// Names the source directly, not "a connected service", since the reader just picked it; a Front Desk isn't a service,
// so it says what actually happens.
const whenCaption = computed<string>(() => {
    if (form.kind !== `listener`) {
        return KIND_CAPTION[form.kind];
    }
    return isFrontDesk.value
        ? `When a visitor writes in the chat widget on your site: one conversation each, live for you to take over.`
        : `The moment ${listenerSource.value.label} sends one of these. Nothing is polled: a gateway holds the connection open.`;
});

// Wrapped, not bound straight to `form.kind`: switching to Live also has to pick a connected source.
const kind = computed<TriggerKind>({
    get: () => form.kind,
    set: (next) => {
        form.kind = next;
        if (next === `listener` && !liveSources.value.some((source) => source.provider === form.provider)) {
            form.provider = liveSources.value[0]?.provider ?? `discord`;
        }
    },
});

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

// Worded as the moment, not the wire event id, since two ids can fire on the same turn and read as one.
const WORKSPACE_EVENTS = [
    { value: `turn.settled`, label: `A turn settles`, hint: `After every isolated agent turn, including the ones that errored or conflicted.` },
    { value: `agent.landed`, label: `Work lands`, hint: `Only when an agent's work actually reaches your workspace.` },
    {
        value: `deps.broken`,
        label: `Checks break`,
        hint: `A landed change drifted the dependencies, and the reinstalled tree failed its own checks.`,
    },
    { value: `deps.fixed`, label: `Checks recover`, hint: `A later land turned those failing checks green again.` },
] as const;

// An ordered ladder of picks, walked at fire time; row 1 is preferred, the rest catch it when that account has nothing
// left. No longer defaultable: `modelsError` requires at least one.
const rungs = computed(() =>
    form.models.map((pin) => {
        const described = host().models.describe({
            provider: pin.provider,
            model: pin.model,
            // Shown only while the account is unambiguous (`accountPinnable`).
            ...(accountPinnable.value && form.account !== `` ? { account: form.account } : {}),
            ...(pin.harness !== undefined ? { harness: pin.harness } : {}),
            ...(pin.effort !== undefined ? { effort: pin.effort } : {}),
        });
        return [described.label, described.accountLabel].filter((part) => part !== undefined && part !== ``).join(` · `);
    }),
);

// An account id only means something beside its own provider, so it can only be pinned while every rung agrees on one;
// crossing providers clears it, falling back to the connected account with the most headroom, same as the scheduler.
const accountPinnable = computed(() => new Set(form.models.map((pin) => pin.provider)).size <= 1);

// A function ref, not one shared element, since the picker anchors to whichever row opened it (popover or sheet; the
// host decides).
const rungEls = new Map<number, HTMLElement>();
const bindRung = (index: number, el: unknown): void => {
    if (el instanceof HTMLElement) {
        rungEls.set(index, el);
    } else {
        rungEls.delete(index);
    }
};

/* WHERE THE PICKER OPENS FROM: the rung being edited, or an empty selection for the slot past the end.
 * `chooseRun` is on because a rung STORES all three of them now (ModelPin carries effort, thinking and speed) —
 * the flag exists to stop a form showing controls whose answers it would drop, and this form drops none.
 * The verb is left to default ("Use this model"): a rung is stored, not spent, and the press is the save. */
const pickerOptions = (anchor: HTMLElement, current: ModelPin | undefined) => {
    // Blank provider and model are what "nothing chosen yet" looks like to the picker, which is the state the
    // add button opens in; an existing rung opens on itself.
    const { provider = ``, model = ``, harness, effort, thinking, fast } = current ?? {};
    return {
        anchor,
        provider,
        model,
        ...(accountPinnable.value && form.account !== `` ? { account: form.account } : {}),
        ...(harness !== undefined ? { harness } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(fast !== undefined ? { fast } : {}),
        chooseRun: true,
    };
};

// A pick as a stored rung. Absent stays absent, never an invented default: a knob the owner did not touch is one
// the model answers for itself, which is the contract every other reader of a pin keeps.
const pinOf = (picked: {
    provider: string;
    model: string;
    effort?: string | undefined;
    harness?: string | undefined;
    thinking?: boolean | undefined;
    fast?: boolean | undefined;
}): ModelPin => ({
    provider: picked.provider,
    model: picked.model,
    ...(picked.effort !== undefined && picked.effort !== `` ? { effort: picked.effort } : {}),
    ...(picked.harness !== undefined && picked.harness !== `` ? { harness: picked.harness as ModelPin["harness"] } : {}),
    ...(picked.thinking !== undefined ? { thinking: picked.thinking } : {}),
    ...(picked.fast !== undefined ? { fast: picked.fast } : {}),
});

// Open the picker over one rung and write back whatever it settles on.
const editRung = async (index: number): Promise<void> => {
    const anchor = rungEls.get(index);
    if (anchor === undefined) {
        return;
    }
    const next = await host().models.pick(pickerOptions(anchor, form.models[index]));
    if (next === undefined) {
        return;
    }
    const pin = pinOf(next);
    form.models = index < form.models.length ? form.models.map((old, at) => (at === index ? pin : old)) : [...form.models, pin];
    // The account is the automation's, not the rung's, kept only while one provider owns the whole ladder.
    form.account = accountPinnable.value ? (next.account ?? ``) : ``;
};

// Opens the picker on the slot past the end; nothing is appended until it actually settles on a model.
const addRung = (): Promise<void> => editRung(form.models.length);

const removeRung = (index: number): void => {
    form.models = form.models.filter((_, at) => at !== index);
    // Marks touched here, so the required-model message appears now, not only when a save is refused.
    markTouched(`models`);
    if (!accountPinnable.value) {
        form.account = ``;
    }
};

// Edited by one step per press, not drag, since order is what the daemon walks and a press works the same on a phone.
const moveRung = (index: number, by: number): void => {
    const to = index + by;
    const moving = form.models[index];
    const displaced = form.models[to];
    if (moving === undefined || displaced === undefined) {
        return;
    }
    form.models = form.models.map((pin, at) => (at === index ? displaced : at === to ? moving : pin));
};

const toggleDay = (day: number): void => {
    const at = schedule.days.indexOf(day);
    if (at === -1) {
        schedule.days.push(day);
        return;
    }
    schedule.days.splice(at, 1);
};

// Clears the event filter on switch, since an old filter (e.g. `pipeline_failed`) may match nothing on the new source.
const setProvider = (provider: string): void => {
    form.provider = provider;
    form.eventType = undefined;
};
</script>

<template>
    <!-- `divide-y` puts a hairline between steps only, not around each one, so the panel reads as three sections, not three boxes. -->
    <div class="@container flex flex-col divide-y divide-line-subtle">
        <!-- The name is the daemon's upsert key; retyping it while editing would fork a new automation, not rename this one. Hidden once it exists. -->
        <section v-if="!nameLocked" class="flex flex-col gap-2 pb-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">Name</span>
                <span class="text-2xs text-subtle">How you'll find it later.</span>
            </div>
            <label class="ui-field min-w-0 max-w-sm flex-1">
                <input
                    ref="nameInput"
                    v-model="form.id"
                    placeholder="morning-briefing"
                    :class="[ui.input(), touched.has('name') && nameError ? 'ui-field-error-box' : '']"
                    @blur="markTouched('name')"
                />
                <span v-if="touched.has('name') && nameError" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ nameError }}
                </span>
            </label>
        </section>

        <!-- ── WHEN ──────────────────────────────────────────────────────────────────────────────────────── -->
        <section class="flex flex-col gap-3 py-4 first:pt-0 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">When</span>
                <span class="text-2xs text-subtle">What wakes the agent.</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <!--
                    Capped at `max-w-2xl`, not full width: `stretch` would otherwise blow up four one-word tabs into slabs wider than the choice they
                    represent.
                -->
                <SegmentedControl v-model="kind" :options="TRIGGER_TABS" stretch class="max-w-2xl" />
                <p class="text-2xs text-subtle">{{ whenCaption }}</p>

                <!-- A chore's trigger: which moment in the fleet's own work wakes it, and optionally one repo of
                     the change to care about. -->
                <template v-if="form.kind === 'workspace'">
                    <div class="ui-field">
                        <span class="ui-field-label">Wake when</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="option in WORKSPACE_EVENTS"
                                :key="option.value"
                                type="button"
                                class="ui-chip"
                                :class="form.workspaceEvent === option.value ? `ui-chip-on` : ``"
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
                    <label class="ui-field max-w-sm">
                        <span class="ui-field-label">Only this repo (optional)</span>
                        <input v-model="form.repo" placeholder="every repo the change touched" class="font-mono" :class="ui.input()" />
                    </label>
                </template>

                <template v-if="form.kind === 'listener'">
                    <!--
                        Chips, not cards: the kit's chip already says "this one" in one signal, and a chip row wraps where a card wall would just
                        grow. The logo stays, so a reader finds Discord without reading a word.
                    -->
                    <div class="ui-field">
                        <span class="ui-field-label">Source</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="source in visibleSources"
                                :key="source.provider"
                                type="button"
                                class="ui-chip"
                                :class="form.provider === source.provider ? `ui-chip-on` : ``"
                                :aria-pressed="form.provider === source.provider"
                                :disabled="!source.available"
                                @click="setProvider(source.provider)"
                            >
                                <img v-if="source.logo" :src="`https://cdn.simpleicons.org/${source.logo}`" class="h-3.5 w-3.5" alt="" />
                                <Icon v-else :name="glyph(source.icon) ?? 'bolt'" class="text-2xs" />
                                {{ source.label }}
                                <span v-if="!source.available" class="text-warning">unavailable</span>
                            </button>
                        </div>
                    </div>

                    <!--
                        A Front Desk is configured by where it embeds and who may talk to it, not the shared listener fields, which fold away. Eight
                        fields flow two-up instead of stacking eight rows.
                    -->
                    <div v-if="isFrontDesk" class="grid gap-3 @2xl:grid-cols-2">
                        <label class="ui-field @2xl:col-span-2">
                            <span class="ui-field-label">Allowed sites</span>
                            <textarea
                                v-model="form.origins"
                                rows="2"
                                placeholder="https://example.com&#10;https://www.example.com"
                                class="font-mono"
                                :class="[ui.input(), touched.has('origins') && originsError ? 'ui-field-error-box' : '']"
                                @blur="markTouched('origins')"
                            ></textarea>
                            <span v-if="touched.has('origins') && originsError" class="ui-field-error">
                                <Icon name="exclamation-triangle" class="text-2xs" />
                                {{ originsError }}
                            </span>
                            <p v-else class="text-2xs text-subtle">One per line, scheme and host only. www and the bare domain count separately.</p>
                        </label>
                        <div class="ui-field">
                            <span class="ui-field-label">Who can chat</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    v-for="option in ACCESS_OPTIONS"
                                    :key="option.value"
                                    type="button"
                                    class="ui-chip"
                                    :class="form.access === option.value ? `ui-chip-on` : ``"
                                    :aria-pressed="form.access === option.value"
                                    @click="form.access = option.value"
                                >
                                    {{ option.label }}
                                </button>
                            </div>
                        </div>
                        <div class="ui-field">
                            <span class="ui-field-label">Bot check</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    v-for="option in ANTI_BOT_OPTIONS"
                                    :key="option.value"
                                    type="button"
                                    class="ui-chip"
                                    :class="form.antiBot === option.value ? `ui-chip-on` : ``"
                                    :aria-pressed="form.antiBot === option.value"
                                    @click="form.antiBot = option.value"
                                >
                                    {{ option.label }}
                                </button>
                            </div>
                            <p class="text-2xs text-subtle">
                                <template v-if="form.antiBot === 'pow'">About a second of each visitor's browser time. No keys.</template>
                                <template v-else-if="form.antiBot === 'turnstile'">Invisible for most visitors. Needs a Cloudflare widget.</template>
                                <template v-else>Only the allowed sites and the daily limit are left.</template>
                            </p>
                        </div>
                        <label v-if="form.access === 'google'" class="ui-field">
                            <span class="ui-field-label">Google client ID</span>
                            <input
                                v-model="form.googleClientId"
                                placeholder="1234-abc.apps.googleusercontent.com"
                                class="font-mono"
                                :class="ui.input()"
                            />
                            <p class="text-2xs text-subtle">Your site's own OAuth client. Add each allowed site to it as an authorized origin.</p>
                        </label>
                        <template v-if="form.antiBot === 'turnstile'">
                            <label class="ui-field">
                                <span class="ui-field-label">Turnstile site key</span>
                                <input v-model="form.turnstileSiteKey" placeholder="0x4AAA…" class="font-mono" :class="ui.input()" />
                            </label>
                            <label class="ui-field">
                                <span class="ui-field-label">Turnstile secret key</span>
                                <input v-model="form.turnstileSecret" type="password" placeholder="0x4AAA…" class="font-mono" :class="ui.input()" />
                                <p class="text-2xs text-subtle">Stays in your sandbox: only the site key is ever sent to a visitor's browser.</p>
                            </label>
                        </template>
                        <label class="ui-field">
                            <span class="ui-field-label">Greeting (optional)</span>
                            <input v-model="form.greeting" placeholder="Hi! Ask me anything." :class="ui.input()" />
                        </label>
                        <label class="ui-field">
                            <span class="ui-field-label">Daily message limit</span>
                            <input
                                v-model="form.dailyMessageMax"
                                type="number"
                                min="1"
                                :placeholder="String(WEBCHAT_DAILY_MAX_DEFAULT)"
                                :class="ui.input()"
                            />
                            <p class="text-2xs text-subtle">
                                Each message runs an agent turn on your account. Blank means {{ WEBCHAT_DAILY_MAX_DEFAULT }} a day.
                            </p>
                        </label>
                    </div>

                    <div v-else class="grid gap-3 @2xl:grid-cols-2">
                        <div class="ui-field @2xl:col-span-2">
                            <span class="ui-field-label">Events</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    type="button"
                                    class="ui-chip"
                                    :class="form.eventType === undefined ? `ui-chip-on` : ``"
                                    :aria-pressed="form.eventType === undefined"
                                    @click="form.eventType = undefined"
                                >
                                    Any
                                </button>
                                <button
                                    v-for="eventOption in listenerSource.events"
                                    :key="eventOption.value"
                                    type="button"
                                    class="ui-chip"
                                    :class="form.eventType === eventOption.value ? `ui-chip-on` : ``"
                                    :aria-pressed="form.eventType === eventOption.value"
                                    @click="form.eventType = eventOption.value"
                                >
                                    {{ eventOption.label }}
                                </button>
                            </div>
                            <label
                                v-if="form.eventType === 'message' && listenerSource.mentionLabel"
                                class="flex items-center gap-2 text-xs text-muted"
                            >
                                <ToggleSwitch v-model="form.mentioned" :aria-label="listenerSource.mentionLabel" />
                                {{ listenerSource.mentionLabel }}
                            </label>
                        </div>
                        <label class="ui-field">
                            <span class="ui-field-label">{{ listenerSource.channel.label }}</span>
                            <input v-model="form.channelId" :placeholder="listenerSource.channel.placeholder" class="font-mono" :class="ui.input()" />
                        </label>
                        <!-- CI's own second narrowing axis (branch); without it, "wake on CI failure" means every agent's branch too. -->
                        <label v-if="branchField" class="ui-field">
                            <span class="ui-field-label">{{ branchField.label }}</span>
                            <input v-model="form.branch" :placeholder="branchField.placeholder" class="font-mono" :class="ui.input()" />
                            <p class="text-2xs text-subtle">{{ branchField.hint }}</p>
                        </label>
                    </div>
                </template>

                <template v-if="form.kind === 'schedule'">
                    <div class="ui-field">
                        <span class="ui-field-label">Repeats</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="option in FREQ_OPTIONS"
                                :key="option.value"
                                type="button"
                                class="ui-chip"
                                :class="schedule.freq === option.value ? `ui-chip-on` : ``"
                                :aria-pressed="schedule.freq === option.value"
                                @click="schedule.freq = option.value"
                            >
                                {{ option.label }}
                            </button>
                        </div>
                    </div>
                    <!-- One wrapping row, not stacked, since "Mon…Sun" and "At 09:00" are also spoken side by side. -->
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <div v-if="schedule.freq === 'weekly'" class="flex flex-wrap gap-1.5">
                            <button
                                v-for="day in DAY_OPTIONS"
                                :key="day.value"
                                type="button"
                                class="ui-chip"
                                :class="schedule.days.includes(day.value) ? `ui-chip-on` : ``"
                                :aria-pressed="schedule.days.includes(day.value)"
                                @click="toggleDay(day.value)"
                            >
                                {{ day.label }}
                            </button>
                        </div>
                        <label v-if="schedule.freq === 'minutes'" class="flex items-center gap-2 text-xs text-muted">
                            Every
                            <input v-model.number="schedule.everyMinutes" type="number" min="1" max="59" class="w-20" :class="ui.input()" /> minutes
                        </label>
                        <label v-if="schedule.freq === 'monthly'" class="flex items-center gap-2 text-xs text-muted">
                            On day <input v-model.number="schedule.dayOfMonth" type="number" min="1" max="31" class="w-20" :class="ui.input()" />
                        </label>
                        <label
                            v-if="schedule.freq === 'daily' || schedule.freq === 'weekly' || schedule.freq === 'monthly'"
                            class="flex items-center gap-2 text-xs text-muted"
                        >
                            <!-- Wide enough for a 12-hour locale: `w-28` clipped the AM/PM suffix in en-US browsers. -->
                            At <input v-model="schedule.time" type="time" class="w-36" :class="ui.input()" />
                        </label>
                        <label v-if="schedule.freq === 'custom'" class="flex min-w-0 flex-col gap-1">
                            <input v-model="schedule.cron" placeholder="0 9 * * 1-5" class="w-48" :class="ui.input('font-mono')" />
                            <span class="text-2xs text-subtle">Standard 5-field cron: minute hour day month weekday.</span>
                        </label>
                    </div>
                    <p v-if="schedule.freq === 'weekly' && schedule.days.length === 0" class="text-xs text-danger">Pick at least one day.</p>
                    <!-- Proof the cron does what it says: shows when it will actually fire next. -->
                    <p v-if="cronPreview" class="text-xs" :class="'error' in cronPreview ? 'text-danger' : 'text-muted'">
                        <template v-if="'runs' in cronPreview">Next runs: {{ cronPreview.runs.map(formatDateTime).join(" · ") }}</template>
                        <template v-else>{{ cronPreview.error }}</template>
                    </p>
                    <!--
                        Gates on sessions since the last wake, not elapsed time; a due run short of the bar shows as skipped, with the count, not as
                        a failure.
                    -->
                    <label class="flex flex-wrap items-center gap-2 text-xs text-muted">
                        Only once
                        <input
                            v-model.number="form.afterSessions"
                            type="number"
                            min="0"
                            class="w-20 font-mono"
                            :class="ui.input()"
                            aria-label="New sessions required since the last wake before a due run fires"
                        />
                        new sessions have run since it last woke
                    </label>
                    <p class="text-2xs text-subtle">
                        0 fires on every occurrence. Short of the bar, a due run is recorded as skipped and says how far off it is.
                    </p>
                </template>

                <!--
                    CI has no held-open gateway: its events arrive by webhook, or by polling if that couldn't register. Stated here, or a silently
                    dead row is only found from an empty run history.
                -->
                <p v-if="isCi && delivery" class="flex items-start gap-1.5 text-xs" :class="DELIVERY_TONE[delivery.state]">
                    <Icon :name="DELIVERY_ICON[delivery.state]" class="mt-0.5 shrink-0 text-2xs" />
                    <span>
                        {{ delivery.summary }}
                        <span v-if="delivery.detail" class="mt-1 block text-2xs text-subtle">{{ delivery.detail }}</span>
                    </span>
                </p>
            </div>
        </section>

        <!-- ── THEN ──────────────────────────────────────────────────────────────────────────────────────── -->
        <section class="flex flex-col gap-3 py-4 @2xl:flex-row @2xl:gap-6">
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">Then</span>
                <span class="text-2xs text-subtle">What it wakes with.</span>
                <!--
                    Unvalidated, but must agree with the trigger above (a Discord briefing on a CI trigger reads a payload it never gets); the rail
                    names its starting point while it's still unedited.
                -->
                <span v-if="recipeNote" class="mt-1 text-2xs text-subtle">Starter from {{ recipeNote }}.</span>
                <span v-else-if="starterPrompt && form.prompt === starterPrompt" class="mt-1 text-2xs text-subtle">
                    {{ listenerSource.label }}'s starter, yours to rewrite.
                </span>
            </div>
            <label class="ui-field min-w-0 flex-1 cursor-text">
                <!--
                    A writing surface, not a form control, using the same bare field the story editor does: no box, no fill, focus lights the line,
                    not a rectangle. `-mx-2` aligns its text with the column; `min-h-24` keeps an empty prompt clickable.
                -->
                <ProseField
                    ref="promptField"
                    v-model="form.prompt"
                    placeholder="Check the inbox and summarize anything urgent."
                    class="-mx-2 min-h-24"
                    @blur="markTouched('prompt')"
                />
                <span v-if="touched.has('prompt') && promptError" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ promptError }}
                </span>
                <!-- A starter left over from a different source; not the form's to rewrite, but worth flagging with a way to swap it. -->
                <p v-else-if="staleStarter" class="flex flex-wrap items-baseline gap-x-1.5 text-2xs text-warning">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    <span>This is {{ staleStarter.label }}'s starter, but {{ listenerSource.label }} sends a different payload.</span>
                    <button type="button" :class="ui.textAction()" @click="applyStarter">Use the {{ listenerSource.label }} starter</button>
                </p>
            </label>
        </section>

        <!-- ── RUNS AS ───────────────────────────────────────────────────────────────────────────────────── -->
        <!--
            Decides who the agent is outside the sandbox, what pays for the wake, and whether it can act unwatched: exactly what a reader of someone
            else's automation most wants to see, so nothing here folds away.
        -->
        <section class="flex flex-col gap-3 pt-4 @2xl:flex-row @2xl:gap-6">
            <!--
                "How", not "Runs as": that label sat inches from a field called "Runs on", one letter apart and meaning different things (what pays
                vs. whose accounts). Also completes the sentence When · Then · How.
            -->
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">How</span>
                <span class="text-2xs text-subtle">Who it runs as, and what pays for it.</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <!--
                    Side by side, not stacked, since stacking these two same-shaped pickers invited confusing what pays ("Runs on") with who it acts
                    as ("Runs as").
                -->
                <div class="grid gap-3 @xl:grid-cols-2">
                    <!--
                        In the order the daemon walks it: row 1 is preferred, the rest catch it when that account is out, the difference between a
                        quiet morning and a wake that never happened.
                    -->
                    <div class="ui-field min-w-0">
                        <span class="ui-field-label">Runs on</span>
                        <div class="flex min-w-0 flex-col gap-1.5">
                            <div v-for="(label, index) in rungs" :key="index" class="flex min-w-0 items-center gap-1.5">
                                <!-- The number is the row's whole meaning: order matters here, so it has to be shown. -->
                                <span class="w-3 shrink-0 text-right text-2xs text-subtle tabular-nums">{{ index + 1 }}</span>
                                <button
                                    :ref="(el) => bindRung(index, el)"
                                    type="button"
                                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-left text-sm text-content transition-colors hover:border-line-strong"
                                    :aria-label="`Model ${index + 1} for this automation: ${label}. Change it`"
                                    @click="editRung(index)"
                                >
                                    <Icon name="sparkles" class="shrink-0 text-subtle" />
                                    <span class="min-w-0 flex-1 truncate">{{ label }}</span>
                                    <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
                                </button>
                                <!--
                                    Invisible, not absent, on the first row: removing it would shorten that row's chip and misread as a layout
                                    mistake.
                                -->
                                <button
                                    type="button"
                                    v-tooltip.top="`Try this one earlier`"
                                    :class="ui.iconButton(index === 0 ? `invisible` : ``)"
                                    :disabled="index === 0"
                                    :aria-hidden="index === 0"
                                    :tabindex="index === 0 ? -1 : undefined"
                                    :aria-label="`Move model ${index + 1} up`"
                                    @click="moveRung(index, -1)"
                                >
                                    <Icon name="chevron-up" />
                                </button>
                                <button
                                    type="button"
                                    v-tooltip.top="`Remove this model`"
                                    :class="ui.iconButton()"
                                    :aria-label="`Remove model ${index + 1}`"
                                    @click="removeRung(index)"
                                >
                                    <Icon name="times" />
                                </button>
                            </div>
                            <button type="button" :class="ui.addTile(`self-start px-3 py-2`)" @click="addRung">
                                <Icon name="plus" />
                                {{ form.models.length === 0 ? `Pick a model` : `Add a fallback` }}
                            </button>
                        </div>
                        <!-- Its error is about spending, not syntax, so it's shown here, not only on the disabled save button. -->
                        <p v-if="modelsError !== undefined && touched.has(`models`)" class="text-2xs text-danger">{{ modelsError }}</p>
                    </div>
                    <div class="ui-field min-w-0">
                        <span class="ui-field-label">Persona</span>
                        <Picker v-model="form.actsAs" :options="personaOptions" aria-label="Persona this automation runs as" class="w-full" />
                    </div>
                </div>
                <!-- Blank on a Front Desk isn't "unbounded": saving writes a read-only front-desk persona, which no control on screen shows. -->
                <p v-if="isFrontDesk && form.actsAs === ``" class="-mt-1 text-2xs text-subtle">
                    Strangers write these prompts, so saving adds a read-only front desk to your personas.
                </p>

                <!-- One line, since they compose: approval holds every fire for a click, the countdown holds it and starts by itself. -->
                <div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line-subtle pt-3">
                    <label class="flex items-center gap-2 text-xs text-content">
                        <ToggleSwitch v-model="form.requireApproval" aria-label="Require my approval before running" />
                        Require my approval before it runs
                    </label>
                    <!-- Approval always beats the hold; disabled, the field enforces that itself instead of a warning you had to read. -->
                    <label class="flex items-center gap-2 text-xs" :class="form.requireApproval ? `text-subtle` : `text-content`">
                        Hold each run for
                        <input
                            v-model.number="form.holdForSeconds"
                            type="number"
                            min="0"
                            step="10"
                            class="w-20 font-mono"
                            :class="ui.input()"
                            :disabled="form.requireApproval"
                            aria-label="Seconds to hold each run before it starts"
                        />
                        seconds
                    </label>
                </div>
                <!-- Said here, not just in the docs, since "require my approval" doesn't sound like a chat that never answers. -->
                <p v-if="form.requireApproval && isFrontDesk" class="-mt-1 text-2xs text-warning">
                    Visitors get no answer in the widget: approved replies land in your chat instead.
                </p>

                <!--
                    Folded away since it's not the usual answer: the persona above is reusable, this only narrows one job further, and can never
                    grant back what the persona's card switched off.
                -->
                <details v-if="form.actsAs !== ``" class="text-xs">
                    <summary class="cursor-pointer text-muted hover:text-content">Narrow this one job further</summary>
                    <div class="ui-field mt-2 max-w-sm">
                        <input
                            v-model="form.allowedTools"
                            :class="ui.input()"
                            placeholder="Read, Grep, Glob"
                            aria-label="Tool names this job may call"
                        />
                        <p class="text-2xs text-subtle">Tool names, comma-separated. Empty leaves the persona's own list alone.</p>
                    </div>
                </details>
            </div>
        </section>
    </div>
</template>
