<script setup lang="ts">
import { WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import {
    ui,
    formatDateTime,
    Icon,
    type IconName,
    Picker,
    type PickerOption,
    ProseField,
    ResizeSeam,
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

/* EVERY FIELD OF AN AUTOMATION, once: rendered by the composer that creates one and by the row that edits one.
 *
 * The two used to be one, because editing did not exist: an automation could only be made, never changed, and
 * the fields lived inside the dialog that made it. Adding an editor meant either a second copy of forty fields
 * or this. A copy would have drifted on the first Front Desk setting anyone added to one and not the other, and
 * the half that drifted would be the half nobody had open while they were changing the other.
 *
 * So the STATE is a composable (useAutomationForm) and the MARKUP is this component, and the two callers differ
 * only in their chrome: a panel at the top of the list, or a panel inside the row.
 *
 * ── THREE FULL-WIDTH STEPS, WHICH IS THE THIRD LAYOUT THIS FORM HAS HAD AND THE FIRST THAT CANNOT DEFORM ─────
 *
 * It was a 44rem MODAL COLUMN: forty fields stacked, a Front Desk's eight of them scrolled past before the
 * Prompt was even reached. Then it was TWO COLUMNS, when creating and editing both moved to page width: "When"
 * beside "Then", which reads as the sentence it is — and which had one failure mode nobody could design out of
 * it. The two columns were made to end together, so the Prompt STRETCHED to whatever the trigger column
 * happened to be, and a Front Desk's trigger column is eight fields tall: the result was a 700-pixel black
 * rectangle holding two lines of text, next to a column of eight controls. Measured on the real form, that
 * rectangle was the largest single element on the page.
 *
 * The defect is not the stretching, it is the ASSUMPTION: that two questions of wildly different sizes should
 * be given the same box. They should not. So each step now takes the FULL WIDTH and exactly the height it
 * needs, in a label rail beside its content — the shape every settings surface in this app already uses:
 *
 *      When   ┃ [ Schedule | Webhook | Live | Workspace ]
 *   what wakes┃ the fields that trigger owns, flowed two-up where they are short
 *  ───────────┃──────────────────────────────────────────────────────────────────
 *      Then   ┃ the prompt, at the width of the page rather than half of it
 *  ───────────┃──────────────────────────────────────────────────────────────────
 *    Runs as  ┃ model · persona · approval, on screen rather than behind "Advanced"
 *
 * WHAT THIS BUYS, beyond the rectangle: the Prompt is the longest text in the product and now gets the whole
 * measure instead of half of it; a Front Desk's eight fields flow two-up into four rows instead of eight; and
 * the rail's three labels replace the ladder of eight uppercase field labels that the two-column version stacked
 * down its left edge. A schedule automation — the common case — is now SHORTER than it was.
 *
 * ADVANCED IS GONE, AND THAT IS THE POINT. It held four controls behind a fold that then had to open itself
 * whenever any of them was set, because "a pin you cannot see is a pin you will not remember making" — a fold
 * that is open whenever it matters is not a fold, it is a step, so it is drawn as one. */

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
} = props.state;

/* THE PERSONAS THIS SANDBOX CAN WEAR, for the "Runs as" picker below. Read here rather than passed in because
 * it is the same list for every automation and changes only when the owner edits it.
 *
 * NAMES ONLY. This picker used to badge every card with whether its accounts were signed in and print its
 * bounds underneath, which made a perfectly good persona look broken on the one surface where you are choosing
 * one: a card with no connected account still scopes the toolbox and the folders, and where it can post is a
 * fact the Personas page already tells. A picker's job here is to name the choices. */
const personaList = useQuery({
    queryKey: host().sandbox.key(`personas`),
    queryFn: () => host().sandbox.rpc.personas.list(),
    enabled: computed(() => host().sandbox.reachable()),
});
const personas = computed<readonly PickerOption[]>(() =>
    (personaList.data.value?.personas ?? [])
        /* `face` is what makes the row a PERSON rather than a value: the picker draws this card's own derived
         * character for it, in the row and again in the closed field, so choosing who an automation speaks as is
         * the same act of recognition here as it is on the Personas page and in the chat. The card goes over
         * whole rather than as a name because the label-or-id rule belongs to <PersonaFace>, not to this file. */
        .map((persona) => ({ value: persona.id, label: persona.label ?? persona.id, face: persona }))
        // Ordered, because a picker whose rows arrive in the file's order is a list you have to read twice.
        .toSorted((a, b) => a.label.localeCompare(b.label)),
);

/* The rows, blank first. Blank means something different on a Front Desk: a stranger writes those prompts, so
 * leaving it alone is filled in with the read-only front desk on save, and the row says which it is.
 *
 * A PIN WHOSE CARD IS GONE still has to appear, or the trigger renders empty and reads as "nobody", which is
 * the one other thing it could mean and behaves very differently: that one gets nothing at all.
 *
 * NEITHER OF THE BLANK ROW'S TWO MEANINGS IS A PERSON, so it wears a glyph while everything under it wears a
 * face, which is the whole of how a reader tells "no one in particular" from "this one" at a glance, without
 * reading either label. The missing card is a person who is GONE, so it keeps a face: greying the row is what
 * says it cannot be used, and drawing it as a category would hide that a name was pinned here at all. */
const personaOptions = computed<readonly PickerOption[]>(() => [
    isFrontDesk.value
        ? { value: ``, label: `Front desk`, description: `read-only`, icon: `globe` as const }
        : { value: ``, label: `Nobody`, description: `no accounts`, icon: `circle` as const },
    ...personas.value,
    ...(form.actsAs !== `` && !personas.value.some((persona) => persona.value === form.actsAs)
        ? [{ value: form.actsAs, label: form.actsAs, description: `no longer exists`, face: { id: form.actsAs }, disabled: true }]
        : []),
]);

// A CI trigger's delivery path, whether this will fire instantly, be polled, or never fire at all. Only
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
// <ProseField> rather than a bare textarea, so what a caller wants (the element to put a caret in) is the
// field inside it rather than the component.
const nameInput = ref<HTMLInputElement>();
const promptField = ref<InstanceType<typeof ProseField>>();
const promptInput = computed(() => promptField.value?.field);
defineExpose({ nameInput, promptInput });

/* HOW TALL THE PROMPT IS: a floor, and a ceiling the seam under it drags.
 *
 * IT USED TO BE A MINIMUM THAT STRETCHED, which is how a two-line prompt came to be drawn in a 700-pixel black
 * rectangle: the box was made to reach the bottom of the trigger column standing beside it. Nothing stands
 * beside it now, so the box can do the obvious thing instead — grow with the words from a four-line floor, stop
 * at the ceiling, and scroll past it. A short prompt no longer leaves a void and a forty-line one can no longer
 * push Save below the fold, which are the two failures this control has had, one at a time, for its whole life.
 *
 * The seam therefore drags the CEILING rather than the height: on a short prompt nothing visibly moves until
 * the ceiling passes the words, which is exactly when a reader is dragging it for anything. Double-clicking
 * comes back to PROMPT_MAX. */
const PROMPT_MIN = 96;
const PROMPT_MAX = 208;
const promptHeight = ref(PROMPT_MAX);

/* THE FOUR THINGS THAT CAN WAKE AN AGENT, as the app's own segmented control rather than as four cards this
 * file draws itself. They were 2×2 tinted buttons at `px-3 py-2`, which is the geometry of a primary action:
 * the loudest block in the form was the question "which kind", asked once and answered forever.
 *
 * EACH KEEPS ITS GLYPH, and that is not decoration: the same clock, bolt, live mark and eye are the tile on
 * every row of the list outside this form, so the picker teaches the vocabulary the list is written in. */
const TRIGGER_TABS = computed<readonly { value: TriggerKind; label: string; icon: IconName }[]>(() => [
    { value: `schedule`, label: `Schedule`, icon: `clock` },
    { value: `event`, label: `Webhook`, icon: `bolt` },
    // A live source needs a gateway holding a connection open: no connected source, nothing to offer. It stays
    // while THIS automation is one, so an existing row is never quietly re-pointed by its own editor.
    ...(liveSources.value.length > 0 || form.kind === `listener` ? [{ value: `listener` as const, label: `Live`, icon: `wifi` as const }] : []),
    { value: `workspace`, label: `Workspace`, icon: `eye` },
]);

/* ONE SENTENCE PER KIND, under the picker, where four self-explaining button labels used to be ("Event
 * (webhook)", "Listen (live)", "This workspace"). A label that has to carry its own gloss in brackets is a
 * label doing a caption's job in a control's font. */
const KIND_CAPTION: Record<TriggerKind, string> = {
    schedule: `On a clock, in this sandbox's own timezone.`,
    event: `When any outside system POSTs to its webhook URL, which is shown to you once it exists.`,
    listener: `The moment a connected service sends something. Nothing is polled: a gateway holds the connection open.`,
    workspace: `On a moment in this workspace's own work. No token and no URL: nothing outside the sandbox can fire it.`,
};
// A live trigger's caption names the SOURCE, because "a connected service" is the one thing a reader who has
// already picked one does not need told. The Front Desk is not a service at all — it is a widget on the reader's
// own site — so it says what actually happens.
const whenCaption = computed<string>(() => {
    if (form.kind !== `listener`) {
        return KIND_CAPTION[form.kind];
    }
    return isFrontDesk.value
        ? `When a visitor writes in the chat widget on your site: one conversation each, live for you to take over.`
        : `The moment ${listenerSource.value.label} sends one of these. Nothing is polled: a gateway holds the connection open.`;
});

// The trigger kind, through the picker's model. Wrapped rather than bound straight to `form.kind` because
// switching kind has a consequence (see `setKind`): a live trigger needs a source that is actually connected.
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

// The moments a chore can wake on. Worded as the moment rather than the event id: the id is wire vocabulary,
// and the two overlap enough (a clean turn auto-lands, firing both) that the difference has to read plainly.
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

/* WHAT THE WAKE RUNS ON: provider, account, harness and model, as one chip opening the app's own picker.
 *
 * IT WAS FOUR ROWS OF CHIPS, one per axis, and every one of them was worse than the list the shell already
 * holds. The provider row was the five built-ins hardcoded, so a sandbox with a model endpoint or an installed
 * ACP agent could not point an automation at either, and a provider with no credential connected looked exactly
 * like one that had: on the surface where nobody is watching when it fails. The model row was this extension's
 * own fetch of `/{provider}/models`, eleven chips wrapping onto two lines and one longer with every release. The
 * account row was a second fetch, naming accounts with no idea how much headroom any of them had left, which is
 * the entire question being asked. What replaced all four is `api.models`: searchable across every provider at
 * once, connected first, locked ones marked with what they would cost, each account's plan drawn as a ring and
 * a broken credential marked as broken.
 *
 * A BLANK IS A DEFAULT, not a gap: no model means the provider resolves its own at wake time (which is what
 * keeps a year-old automation running after a model is retired), and no account means whichever comes first.
 * The picker has no rows for those: every row in it is a live, concrete thing, so "back to defaults" is the
 * button beside the chip rather than an entry inside it. */
const runsOn = computed(() =>
    host().models.describe({
        provider: form.agent,
        model: form.model,
        ...(form.account !== `` ? { account: form.account } : {}),
        harness: form.harness,
    }),
);
// ONE LINE, the way the workflow step's chip reads: model · account. The account used to sit outside the
// control as "on <name>", which put a second sentence beside a control that was already saying the thing.
const runsOnLabel = computed(() => [runsOn.value.label, runsOn.value.accountLabel].filter((part) => part !== undefined && part !== ``).join(` · `));
const pinned = computed(() => form.model !== `` || form.account !== ``);

// The element the shell hangs its picker off: a popover on desktop, a sheet on mobile; the host decides.
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

// Switching source changes what an event IS, so the event filter cannot carry over: `pipeline_failed` is not a
// thing Discord sends, and a filter no source matches is a row that never fires.
const setProvider = (provider: string): void => {
    form.provider = provider;
    form.eventType = undefined;
};
</script>

<template>
    <!-- THE RAIL AND ITS RULE, drawn once by the parent: `divide-y` puts a hairline BETWEEN steps and nowhere
         else, which is the difference between three sections and three boxes. A border per section would draw a
         line above the first one, where the panel's own header already is. -->
    <div class="@container flex flex-col divide-y divide-line-subtle">
        <!-- The name IS the automation's identity: the daemon upserts on it, so retyping it while editing
             would fork a second automation rather than rename this one. Absent once it exists; the row above
             is already showing it. -->
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
                <!-- CAPPED, not full-bleed. `stretch` divides whatever width it is given between its options,
                     and at the page's measure that is four 240px slabs for four one-word labels — a control
                     that looks like the form's primary action because it is the widest thing in it. At 42rem
                     the four tabs are the size of the choice they carry. -->
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
                    <!-- THE SOURCES, AS CHIPS RATHER THAN AS CARDS. They were `px-3 py-2` tinted blocks with a
                         trailing check mark inside the lit one, which is three ways of saying "this one" where
                         the kit's own chip says it in one — and the card wall grows with every pack installed,
                         while a chip row wraps. The logo stays: it is how a reader finds Discord in a row of
                         four without reading a word. -->
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

                    <!-- A Front Desk is configured by WHERE it may be embedded and WHO may talk to it: the shared
                         listener fields (events, mention, channel) say nothing about a widget, so they fold away.
                         EIGHT FIELDS, FLOWED TWO-UP: at half the page they were eight rows and the reason the
                         old layout's prompt had 700 pixels to fill. -->
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
                            <input
                                v-model="form.channelId"
                                :placeholder="listenerSource.channel.placeholder"
                                class="font-mono"
                                :class="ui.input()"
                            />
                        </label>
                        <!-- The second narrowing axis, for the one source that has one: CI's branch. Without it,
                             "wake me when CI fails" means every agent's branch as well as the one that ships. -->
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
                    <!-- The qualifier its frequency needs, on ONE wrapping row rather than stacked: at full
                         width "Mon…Sun" and "At 09:00" sit side by side, which is also how they are spoken. -->
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
                            <!-- Wide enough for a 12-hour locale: `w-28` fit "09:00" and the picker glyph, so every
                                 en-US browser rendered "09:00 A" with the M clipped off. -->
                            At <input v-model="schedule.time" type="time" class="w-36" :class="ui.input()" />
                        </label>
                        <label v-if="schedule.freq === 'custom'" class="flex min-w-0 flex-col gap-1">
                            <input v-model="schedule.cron" placeholder="0 9 * * 1-5" class="w-48" :class="ui.input('font-mono')" />
                            <span class="text-2xs text-subtle">Standard 5-field cron: minute hour day month weekday.</span>
                        </label>
                    </div>
                    <p v-if="schedule.freq === 'weekly' && schedule.days.length === 0" class="text-xs text-danger">Pick at least one day.</p>
                    <!-- THE ONE THING THIS STEP OWES: proof. A cron is unreadable and a form that takes one
                         without saying when it will fire is a form you cannot check your own answer against. -->
                    <p v-if="cronPreview" class="text-xs" :class="'error' in cronPreview ? 'text-danger' : 'text-muted'">
                        <template v-if="'runs' in cronPreview">Next runs: {{ cronPreview.runs.map(formatDateTime).join(" · ") }}</template>
                        <template v-else>{{ cronPreview.error }}</template>
                    </p>
                </template>

                <!-- CI is the one source with no gateway holding a connection open: its events arrive by provider
                     webhook, or by polling when that webhook could not be registered. Which of the two, or
                     neither, is the difference between a row that works and a row that silently never fires, so
                     it is stated here rather than left to be discovered from an empty run history. -->
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
                <!-- The one field nothing validates, and the one that has to agree with the trigger above it: a
                     briefing about Discord messages on a CI trigger is a wake that reads a payload it was never
                     told about. So the rail says whose starting point is in the box while it is still one. -->
                <span v-if="recipeNote" class="mt-1 text-2xs text-subtle">Starter from {{ recipeNote }}.</span>
                <span v-else-if="starterPrompt && form.prompt === starterPrompt" class="mt-1 text-2xs text-subtle">
                    {{ listenerSource.label }}'s starter, yours to rewrite.
                </span>
            </div>
            <label class="ui-field min-w-0 flex-1">
                <!-- IT IS A WRITING SURFACE, not a form control. What goes in it is the longest text on this
                     page by an order of magnitude: a briefing with numbered steps, the thing the whole
                     automation turns on, and it was typeset as a name field: `ui.input()`'s bordered box at the
                     form's own leading, its content behind a native scrollbar, and a resize grip that did
                     nothing because `flex-1` overrode every height a drag could set. So it is the same field
                     the story and workflow-step editors write into (<ProseField>): prose leading, no chrome of
                     its own, and now the full width of the form rather than half of it.
                     THE BOX GROWS WITH THE WORDS between a floor and a ceiling, and scrolls past the ceiling:
                     no dead rectangle under a one-line prompt, and no forty-line one turning this panel into a
                     page nobody can reach Save on. See PROMPT_MIN / PROMPT_MAX. -->
                <div class="flex min-h-0 flex-col">
                    <!-- The SHELL is what scrolls and what carries the frame; the field inside it brings its own
                         padding and no chrome, so the writing surface reaches the border on every side and the
                         tint it takes when focused is the whole box lighting up rather than a second rectangle
                         inside the first. -->
                    <div
                        class="ui-field-shell scrollbar-thin cursor-text overflow-y-auto"
                        :class="touched.has('prompt') && promptError ? 'ui-field-error-box' : ''"
                        :style="{ minHeight: `${PROMPT_MIN}px`, maxHeight: `${promptHeight}px` }"
                    >
                        <ProseField
                            ref="promptField"
                            v-model="form.prompt"
                            placeholder="Check the inbox and summarize anything urgent."
                            @blur="markTouched('prompt')"
                        />
                    </div>
                    <!-- ON the bottom edge rather than under it: the seam lays out as 0px and hangs 3px over the
                         border it sizes, so the affordance is the edge of the box itself, which is where a
                         pointer looking for one goes. The click's DEFAULT ACTION is cancelled because the
                         <label> around all of this has one: focus the field and put the caret at its very end.
                         Left alone, every drag of this seam ended by scrolling a long prompt to its last line.
                         `.prevent` rather than `.stop`: the label activates from the click's default action,
                         which propagation stopped anywhere below it does not reach. -->
                    <div @click.prevent>
                        <ResizeSeam v-model="promptHeight" axis="y" pane="before" :min="PROMPT_MIN" :max="720" :reset="PROMPT_MAX" />
                    </div>
                </div>
                <span v-if="touched.has('prompt') && promptError" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ promptError }}
                </span>
                <!-- A starter left over from another source, named with the swap beside it. Nothing may rewrite
                     it — it is not the form's — but it is the one mismatch that can be pointed at. -->
                <p v-else-if="staleStarter" class="flex flex-wrap items-baseline gap-x-1.5 text-2xs text-warning">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    <span>This is {{ staleStarter.label }}'s starter, but {{ listenerSource.label }} sends a different payload.</span>
                    <button type="button" :class="ui.textAction()" @click="applyStarter">Use the {{ listenerSource.label }} starter</button>
                </p>
            </label>
        </section>

        <!-- ── RUNS AS ───────────────────────────────────────────────────────────────────────────────────── -->
        <!-- IT WAS "ADVANCED", and it was neither. These four decide who the agent IS when it reaches outside
             this sandbox, whose subscription pays for the wake, and whether it may act unwatched — which are
             the questions a reader of somebody else's automation most wants answered, and the ones a fold hides
             by design. The fold also had to open itself whenever any of them was set, which is the shape of a
             control that never wanted to be one. -->
        <section class="flex flex-col gap-3 pt-4 @2xl:flex-row @2xl:gap-6">
            <!-- "How", not "Runs as", and the rename is not cosmetic: the rail label sat two inches from a field
                 labelled "Runs on", and one of them means "which subscription pays" while the other means "whose
                 accounts it may speak through" — the exact mix-up the persona layer exists to prevent, invited
                 by two labels that differ in one letter. When · Then · How also reads as the sentence the three
                 steps are. -->
            <div class="flex flex-col gap-0.5 @2xl:w-48 @2xl:shrink-0">
                <span :class="ui.sectionLabel()">How</span>
                <span class="text-2xs text-subtle">Who it runs as, and what pays for it.</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-3">
                <!-- TWO PICKERS, ONE ROW. They are the same KIND of question — which model, which persona — and
                     standing them side by side is also what keeps them from being read as one: "Runs on" is
                     which subscription pays for the wake, "Runs as" is who it is when it reaches outside, and a
                     stacked pair invited exactly the mix-up the persona layer exists to prevent. -->
                <div class="grid gap-3 @xl:grid-cols-2">
                    <div class="ui-field min-w-0">
                        <span class="ui-field-label">Runs on</span>
                        <div class="flex min-w-0 items-center gap-1.5">
                            <button
                                ref="chip"
                                type="button"
                                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-left text-sm text-content transition-colors hover:border-line-strong"
                                :aria-label="`Provider, account and model for this automation: ${runsOnLabel}`"
                                v-action="choose"
                            >
                                <Icon name="sparkles" class="shrink-0 text-subtle" />
                                <span class="min-w-0 flex-1 truncate">{{ runsOnLabel }}</span>
                                <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
                            </button>
                            <!-- Only once there is a pin to clear: a blank model and a blank account ARE the
                                 default, and a reset button beside a default is a control with nothing to do. -->
                            <button
                                v-if="pinned"
                                type="button"
                                v-tooltip.top="`Back to the default model and account`"
                                :class="ui.iconButton()"
                                aria-label="Back to the default model and account"
                                @click="useDefaults"
                            >
                                <Icon name="times" />
                            </button>
                        </div>
                    </div>
                    <div class="ui-field min-w-0">
                        <span class="ui-field-label">Persona</span>
                        <Picker v-model="form.actsAs" :options="personaOptions" aria-label="Persona this automation runs as" class="w-full" />
                    </div>
                </div>
                <!-- The one sentence saving needs: on a Front Desk, leaving this blank does not mean "unbounded",
                     it WRITES a read-only front-desk persona: a thing no control on screen shows. -->
                <p v-if="isFrontDesk && form.actsAs === ``" class="-mt-1 text-2xs text-subtle">
                    Strangers write these prompts, so saving adds a read-only front desk to your personas.
                </p>

                <!-- BOTH HANDS ON THE WHEEL, ON ONE LINE, because they compose and are read together: approval
                     holds every fire for a click, the countdown holds it visibly and then starts by itself. -->
                <div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line-subtle pt-3">
                    <label class="flex items-center gap-2 text-xs text-content">
                        <ToggleSwitch v-model="form.requireApproval" aria-label="Require my approval before running" />
                        Require my approval before it runs
                    </label>
                    <!-- THE CONFLICT IS ENFORCED, not narrated. Approval always beat the hold: a held run never
                         started by itself while it was on, and the old form said so in a warning under a field
                         it left editable, which is a rule you have to read to obey. Disabled, the field says it. -->
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
                <!-- The one place this caveat lands where it changes a decision. It is in the Front Desk docs, but
                     nobody reads those while flipping a toggle, and a support chat that can never answer is not
                     what "require my approval" sounds like. -->
                <p v-if="form.requireApproval && isFrontDesk" class="-mt-1 text-2xs text-warning">
                    Visitors get no answer in the widget: approved replies land in your chat instead.
                </p>

                <!-- NARROW THIS FURTHER: raw tool names, folded away, and deliberately not how anyone is expected
                     to answer this question. The persona above is the reusable answer; this is for the one job
                     that needs less than its card, and it can only ever take away (the daemon applies both, and
                     an allowlist cannot hand back a shelf the card switched off). -->
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
