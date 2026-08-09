<script setup lang="ts">
import { personaBounds, WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import { cmp, formatDateTime, Icon, ProseField, ResizeSeam, ToggleSwitch } from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { host } from "./host";
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
} = props.state;

/* THE PERSONAS THIS SANDBOX CAN WEAR, for the "Runs as" picker below. Read here rather than passed in because
 * it is the same list for every automation and changes only when the owner edits it.
 *
 * Each option also carries whether its accounts are actually signed in, because the honest failure this picker
 * has to make visible is a card that exists and cannot act — the ordinary state of a workspace someone has just
 * cloned, where every persona is one login short of working — and how bounded the card is, because picking one
 * now decides what the wake may DO and not only whose name is on it. */
const personaList = useQuery({
    queryKey: host().sandbox.key(`personas`),
    queryFn: () => host().sandbox.rpc.personas.list(),
    enabled: computed(() => host().sandbox.reachable()),
});
const personas = computed(() =>
    (personaList.data.value?.personas ?? []).map((persona) => ({
        id: persona.id,
        label: persona.label ?? persona.id,
        // Signed in enough to act at all. A card naming three accounts with one connected is still usable —
        // the turn simply reaches the one — so this marks only the persona that can reach nothing whatsoever.
        ready: persona.capabilities.some((capability) => (personaList.data.value?.connected ?? []).includes(capability)),
        // From the contract, so this sentence and the badge on the Personas page describe a card the same way.
        bounds: `${personaBounds(persona)}${persona.workspace?.folders === undefined ? `` : `, ${persona.workspace.folders.join(`, `)} only`}.`,
    })),
);
const actsAsLabel = computed(() => personas.value.find((persona) => persona.id === form.actsAs));

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

// Exposed so a submitting parent can send the user to the first field that needs fixing. The prompt is a
// <ProseField> rather than a bare textarea, so what a caller wants — the element to put a caret in — is the
// field inside it rather than the component.
const nameInput = ref<HTMLInputElement>();
const promptField = ref<InstanceType<typeof ProseField>>();
const promptInput = computed(() => promptField.value?.field);
defineExpose({ nameInput, promptInput });

/* HOW TALL THE PROMPT STARTS, and the floor a drag on the seam under it sets.
 *
 * It is a MINIMUM rather than a height, because the box also stretches to whatever the trigger column beside
 * it happens to be: a Doorbell is eight fields tall, and a prompt that ignored that would end its column 400px
 * short — the dead rectangle that made this panel look broken before the two halves were made to meet. So the
 * drag says "at least this tall" and the layout keeps the rest: on a schedule (a short trigger column) the
 * drag is the whole height and moves the edge pixel for pixel, and on a Doorbell it only bites once dragged
 * past the column. Double-clicking the seam comes back to PROMPT_HEIGHT. */
const PROMPT_HEIGHT = 208;
const promptHeight = ref(PROMPT_HEIGHT);

// Small selectable pills (Repeats, Days, Events, Source, Access) — borderless; selection = a muted brand tint with readable brand text.
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
    {
        value: `deps.broken`,
        label: `Checks break`,
        hint: `A landed change drifted the dependencies, and the reinstalled tree failed its own checks.`,
    },
    { value: `deps.fixed`, label: `Checks recover`, hint: `A later land turned those failing checks green again.` },
] as const;

// Guard/agent/approval fold away by default — revealed on demand or when a recipe prefilled a guard.
const advancedOpen = ref(form.guard !== ``);

/* WHAT THE WAKE RUNS ON — provider, account, harness and model, as one chip opening the app's own picker.
 *
 * IT WAS FOUR ROWS OF CHIPS, one per axis, and every one of them was worse than the list the shell already
 * holds. The provider row was the five built-ins hardcoded, so a sandbox with a model endpoint or an installed
 * ACP agent could not point an automation at either, and a provider with no credential connected looked exactly
 * like one that had — on the surface where nobody is watching when it fails. The model row was this extension's
 * own fetch of `/{provider}/models`, eleven chips wrapping onto two lines and one longer with every release. The
 * account row was a second fetch, naming accounts with no idea how much headroom any of them had left, which is
 * the entire question being asked. What replaced all four is `api.models`: searchable across every provider at
 * once, connected first, locked ones marked with what they would cost, each account's plan drawn as a ring and
 * a broken credential marked as broken.
 *
 * A BLANK IS A DEFAULT, not a gap: no model means the provider resolves its own at wake time (which is what
 * keeps a year-old automation running after a model is retired), and no account means whichever comes first.
 * The picker has no rows for those — every row in it is a live, concrete thing — so "back to defaults" is the
 * button beside the chip rather than an entry inside it. */
const runsOn = computed(() =>
    host().models.describe({
        provider: form.agent,
        model: form.model,
        ...(form.account !== `` ? { account: form.account } : {}),
        harness: form.harness,
    }),
);
const pinned = computed(() => form.model !== `` || form.account !== ``);

// The element the shell hangs its picker off — a popover on desktop, a sheet on mobile; the host decides.
const chip = ref<HTMLElement>();
const choose = async (): Promise<void> => {
    if (chip.value === undefined) {
        return;
    }
    const next = await host().models.pick({
        anchor: chip.value,
        provider: form.agent,
        model: form.model,
        ...(form.account !== `` ? { account: form.account } : {}),
        harness: form.harness,
    });
    if (next === undefined) {
        return;
    }
    form.agent = next.provider as typeof form.agent;
    form.model = next.model;
    form.account = next.account ?? ``;
    form.harness = (next.harness as typeof form.harness) ?? `native`;
};

// Back to what the daemon would have picked anyway. The provider stays: it has no "default" state to return to
// (an automation saved without one MEANS claude), so clearing it would be a silent switch rather than a reset.
const useDefaults = (): void => {
    form.model = ``;
    form.account = ``;
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
const setProvider = (provider: string): void => {
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
                                v-for="source in visibleSources"
                                :key="source.provider"
                                type="button"
                                class="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors"
                                :class="form.provider === source.provider ? CARD_SELECTED : CARD_IDLE"
                                :aria-pressed="form.provider === source.provider"
                                :disabled="!source.available"
                                @click="setProvider(source.provider)"
                            >
                                <img v-if="source.logo" :src="`https://cdn.simpleicons.org/${source.logo}`" class="h-4 w-4" alt="" />
                                <Icon v-else :name="source.icon ?? 'bolt'" class="text-2xs" />
                                {{ source.label }}
                                <span v-if="!source.available" class="text-2xs text-warning">Unavailable</span>
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
                                v-for="eventOption in listenerSource.events"
                                :key="eventOption.value"
                                type="button"
                                :class="[CHIP_BASE, form.eventType === eventOption.value ? CHIP_SELECTED : CHIP_IDLE]"
                                :aria-pressed="form.eventType === eventOption.value"
                                @click="form.eventType = eventOption.value"
                            >
                                {{ eventOption.label }}
                            </button>
                        </div>
                        <label v-if="form.eventType === 'message' && listenerSource.mentionLabel" class="flex items-center gap-2 text-xs text-muted">
                            <ToggleSwitch v-model="form.mentioned" :aria-label="listenerSource.mentionLabel" />
                            {{ listenerSource.mentionLabel }}
                        </label>
                    </div>
                    <label v-if="!isDoorbell" class="ui-field">
                        <span class="ui-field-label">{{ listenerSource.channel.label }}</span>
                        <input v-model="form.channelId" :placeholder="listenerSource.channel.placeholder" class="font-mono" :class="cmp.input()" />
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
                    Fires instantly over {{ listenerSource.label }}'s live connection when the selected events happen — "Any" wakes on every kind.
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
                            · {{ listenerSource.label }} starter — edit it, or leave it and it follows the source
                        </span>
                    </span>
                    <!-- IT IS A WRITING SURFACE, not a form control. What goes in it is the longest text on
                         this page by an order of magnitude — a briefing with numbered steps, the thing the whole
                         automation turns on — and it was typeset as a name field: `cmp.input()`'s bordered box
                         at the form's own leading, its content behind a native scrollbar, and a resize grip that
                         did nothing because `flex-1` overrode every height a drag could set. So it is the same
                         field the story and workflow-step editors write into (<ProseField>): prose leading, no
                         chrome of its own, and a height that follows the words without JavaScript.
                         THE BOX AROUND IT IS WHAT SCROLLS, and the field grows freely inside it — which is what
                         keeps a forty-line prompt from turning this panel into a page nobody can reach Save on,
                         while still letting the whole prompt be read by dragging the seam below it. It stretches
                         to meet the trigger column beside it exactly as before; see PROMPT_HEIGHT. -->
                    <div class="flex min-h-0 flex-1 flex-col">
                        <div
                            class="relative flex-1 rounded-md border bg-canvas transition-colors"
                            :class="
                                touched.has('prompt') && promptError
                                    ? 'ui-field-input-error border-line'
                                    : 'border-line hover:border-line-strong focus-within:border-line-strong'
                            "
                            :style="{ minHeight: `${promptHeight}px` }"
                        >
                            <!-- THE PROSE IS TAKEN OUT OF THE FLOW, which is the whole reason this box has a
                                 scrollbar rather than a height that tracks the words. A scroller in normal flow
                                 still OFFERS its content height to the grid row above it, so a forty-line prompt
                                 sized the row to forty lines, scrolled nothing, and left the trigger column
                                 beside it as 1,200px of empty panel with Save somewhere below the fold. Out of
                                 flow it offers nothing, so the box is exactly `minHeight` or the height of the
                                 trigger column — whichever is greater — and the words scroll inside it.
                                 No padding of its own either: the field's own is the box's, so the writing
                                 surface reaches the border on every side and the tint it takes when focused is
                                 the whole box lighting up rather than a second rectangle inside the first. -->
                            <div class="absolute inset-0 cursor-text overflow-y-auto">
                                <ProseField
                                    ref="promptField"
                                    v-model="form.prompt"
                                    placeholder="Check the inbox and summarize anything urgent."
                                    class="min-h-full"
                                    @blur="markTouched('prompt')"
                                />
                            </div>
                        </div>
                        <!-- ON the bottom edge rather than under it — the seam lays out as 0px and hangs 3px over
                             the border it sizes, so the affordance is the edge of the box itself, which is where
                             a pointer looking for one goes. Grouped with the box for that reason: in the field's
                             own stack it would have sat a gap below, resizing an edge it wasn't touching.
                             The click's DEFAULT ACTION is cancelled because the <label> around all of this has
                             one: focus the field and put the caret at its very end. Left alone, every drag of
                             this seam ended by scrolling a long prompt to its last line. `.prevent` rather than
                             `.stop` — the label activates from the click's default action, which propagation
                             stopped anywhere below it does not reach. -->
                        <div @click.prevent>
                            <ResizeSeam v-model="promptHeight" axis="y" pane="before" :min="128" :max="720" :reset="PROMPT_HEIGHT" />
                        </div>
                    </div>
                    <span v-if="touched.has('prompt') && promptError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ promptError }}
                    </span>
                    <p v-else-if="staleStarter" class="flex flex-wrap items-baseline gap-x-1.5 text-2xs text-warning">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        <span>This is {{ staleStarter.label }}'s starter, but {{ listenerSource.label }} sends a different payload.</span>
                        <button type="button" class="cursor-pointer text-link hover:underline" @click="applyStarter">
                            Use the {{ listenerSource.label }} starter
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
             model chip is what the wake RUNS ON; neither is "what it wakes with", and neither changes when the
             trigger does.
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
                <span v-if="!advancedOpen" class="font-normal normal-case tracking-normal">· guard, model, approval</span>
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
                <!-- WHAT IT RUNS ON — one chip over the app's own picker, where four rows of chips used to be.
                     The chip states the model, and beside it the account, because those are the two facts that
                     decide whether a 6am wake gets an answer; the harness and the provider are inside the pick
                     rather than beside it, since choosing "Claude Opus 5" has already answered both. -->
                <div class="ui-field">
                    <span class="ui-field-label">Runs on</span>
                    <div class="flex flex-wrap items-center gap-2">
                        <button
                            ref="chip"
                            type="button"
                            class="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-content transition-colors hover:border-line-strong"
                            :aria-label="`Provider, account and model for this automation: ${runsOn.label}`"
                            @click="choose"
                        >
                            <Icon name="sparkles" class="shrink-0 text-subtle" />
                            <span class="max-w-[16rem] truncate">{{ runsOn.label }}</span>
                            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
                        </button>
                        <!-- The pinned account, named by the shell (its sign-in identity — the label is "Claude"
                             on an account nobody renamed, which says nothing when three are connected).
                             UNNAMED IS SILENT, not a warning: a pin the shell cannot name is either a credential
                             disconnected since, or an account list that has not been read yet, and those are the
                             same absence. Guessing the first is how a sandbox that is merely still starting up
                             tells you every automation is broken — a claim the UI then has to take back. -->
                        <span v-if="runsOn.accountLabel" class="min-w-0 truncate text-xs text-muted">on {{ runsOn.accountLabel }}</span>
                        <button
                            v-if="pinned"
                            type="button"
                            :class="cmp.linkButton(`ml-auto text-2xs text-muted hover:text-content`)"
                            @click="useDefaults"
                        >
                            Use defaults
                        </button>
                    </div>
                    <p v-if="form.account === ``" class="text-xs text-muted">
                        On the default account this runs on whichever comes first — so it starts failing when that one runs out of headroom or its
                        plan is switched off. Pin one to keep this automation on an account you know can answer.
                    </p>
                    <p v-if="form.model === ``" class="text-xs text-muted">
                        On the default model the provider picks one at each wake, which is what keeps this working after a model is retired.
                    </p>
                </div>
                <!-- RUNS AS — the persona this wake wears, which is now one choice covering three things: whose
                     accounts it may speak through, what it may do, and where in the workspace it works. Kept
                     deliberately apart from "Runs on" just above it, because the two read almost the same and
                     mean opposite things: "Runs on" is which subscription PAYS for the wake. Sharing a row would
                     invite exactly the mix-up the persona layer exists to prevent.

                     Blank is the strict end of this control for accounts and the permissive end for tools, and
                     the note under it says both — that asymmetry is the product's own decision (an unrepeatable
                     post is worth defaulting to nothing for; an over-powered turn in a disposable container is
                     not) and a picker that implied otherwise either way would be lying. -->
                <div class="ui-field">
                    <label class="ui-field-label" for="automation-acts-as">Runs as</label>
                    <select id="automation-acts-as" v-model="form.actsAs" :class="cmp.input()">
                        <option value="">Nobody — no accounts, and every tool</option>
                        <option v-for="persona in personas" :key="persona.id" :value="persona.id">
                            {{ persona.label }}{{ persona.ready ? `` : ` (not signed in yet)` }}
                        </option>
                        <!-- A pin whose card is gone still has to be VISIBLE in the control, or the select
                             renders blank and reads as "nobody" — which is the one other thing it could
                             mean, and the two behave very differently: this one gets NOTHING at all. -->
                        <option v-if="form.actsAs !== `` && actsAsLabel === undefined" :value="form.actsAs" disabled>
                            {{ form.actsAs }} (no longer exists)
                        </option>
                    </select>
                    <!-- The four states this picker can be in, most specific first. The orphan case is third
                         rather than folded into "not signed in": a pin to a persona that no longer exists is
                         read by the turn as no accounts AND no tools, and telling someone to go finish a login
                         for a card that isn't there would send them looking for something they deleted. -->
                    <p v-if="personas.length === 0" class="text-xs text-muted">
                        You haven't set up any personas yet, so this wake can do anything and speak as nobody.
                        <button type="button" :class="cmp.linkButton('inline')" @click="host().navigate(`/sandbox/personas`)">Set one up</button>
                    </p>
                    <p v-else-if="form.actsAs === ``" class="text-xs text-muted">
                        This wake reaches none of your connected accounts — it can work but not post, reply or send as anyone. It does get the full
                        toolbox: pick a persona to bound what it may touch.
                    </p>
                    <p v-else-if="actsAsLabel === undefined" class="text-xs text-warning">
                        This is pinned to a persona that no longer exists, so it gets no accounts and no tools at all. Pick another one.
                    </p>
                    <p v-else-if="!actsAsLabel.ready" class="text-xs text-warning">
                        {{ actsAsLabel.label }} isn't signed in yet, so this wake still can't post. Finish its login under Capabilities first.
                    </p>
                    <p v-else class="text-xs text-muted">
                        {{ actsAsLabel.bounds }}
                        <button type="button" :class="cmp.linkButton('inline')" @click="host().navigate(`/sandbox/personas`)">Edit this persona</button>
                    </p>
                </div>

                <!-- NARROW THIS FURTHER — raw tool names, folded away, and deliberately not how anyone is
                     expected to answer this question. The persona above is the reusable answer; this is for the
                     one job that needs less than its card, and it can only ever take away (the daemon applies
                     both, and an allowlist cannot hand back a shelf the card switched off). -->
                <details v-if="form.actsAs !== ``" class="text-xs">
                    <summary class="cursor-pointer text-muted hover:text-content">Narrow this one job further</summary>
                    <div class="ui-field mt-2">
                        <input
                            v-model="form.allowedTools"
                            :class="cmp.input()"
                            placeholder="Read, Grep, Glob"
                            aria-label="Tool names this job may call"
                        />
                        <p class="text-xs text-subtle">
                            Comma-separated tool names. Leave empty to use everything the persona allows — anything named here is narrowed on top of
                            it, never added back.
                        </p>
                    </div>
                </details>
                <label class="flex items-center gap-2 text-sm text-content">
                    <ToggleSwitch v-model="form.requireApproval" aria-label="Require my approval before running" />
                    Require my approval before it runs
                </label>
                <p v-if="form.requireApproval" class="-mt-1 text-2xs text-subtle">
                    Each time this fires, the agent waits — you approve or reject it under "Pending approvals" before it acts.
                </p>
                <label class="flex items-center gap-2 text-sm text-content">
                    Hold each run for
                    <input
                        v-model.number="form.holdForSeconds"
                        type="number"
                        min="0"
                        step="10"
                        class="w-20 font-mono"
                        :class="cmp.input()"
                        aria-label="Seconds to hold each run before it starts"
                    />
                    seconds before it starts
                </label>
                <p v-if="form.holdForSeconds > 0 && !form.requireApproval" class="-mt-1 text-2xs text-subtle">
                    Each fire waits that long under "Waiting for you", with a countdown — cancel it, start it early, or let it run. It also never
                    starts while another agent is mid-turn.
                </p>
                <p v-if="form.holdForSeconds > 0 && form.requireApproval" class="-mt-1 text-2xs text-warning">
                    "Require my approval" wins: the hold never runs by itself while that is on — only your click starts it.
                </p>
                <!-- The one place this caveat lands where it changes a decision. It is in the Doorbell docs, but
                     nobody reads those while flipping a toggle, and a support chat that can never answer is not
                     what "require my approval" sounds like. -->
                <p v-if="form.requireApproval && isDoorbell" class="-mt-1 text-2xs text-warning">
                    On a Doorbell this means visitors never get an answer in the widget: they see "a human will review this", and the approved reply
                    lands on the conversation for you to handle, not back on their chat.
                </p>
            </template>
        </div>
    </div>
</template>
