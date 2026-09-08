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
    modelsError,
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

/* WHAT THE WAKE RUNS ON: AN ORDERED LADDER, each rung a whole pick — provider, model, reasoning tier and
 * harness — through the app's own picker.
 *
 * IT WAS ONE CHIP, and before that four rows of chips. The chip was right about WHERE the choice is made (the
 * shell's picker: searchable across every provider at once, connected first, each account's plan drawn as a
 * ring) and wrong about how many answers an automation gets. One model meant one point of failure on the
 * surface least able to survive one: a chat refuses in front of somebody who can retry it, a wake at 3am
 * against a spent allowance simply does not happen, and nobody finds out until the morning.
 *
 * AND A BLANK IS NO LONGER A DEFAULT. It used to be — no model meant the provider resolved its own at wake
 * time, and behind that sat a sandbox-wide tier — which made the commonest way to configure an automation's
 * spend "say nothing and inherit whatever the chat was set to". The list is now required (`modelsError`), so
 * the picker is the one step of making an automation that cannot be skipped.
 *
 * ORDER IS THE MEANING: the daemon walks it at fire time and takes the first rung this sandbox can actually
 * start, so row 1 is the one you want and the rest are what catches it. */
const rungs = computed(() =>
    form.models.map((pin) => {
        const described = host().models.describe({
            provider: pin.provider,
            model: pin.model,
            // The account is shown against a rung only while it is unambiguous, see `accountPinnable`.
            ...(accountPinnable.value && form.account !== `` ? { account: form.account } : {}),
            ...(pin.harness !== undefined ? { harness: pin.harness } : {}),
            ...(pin.effort !== undefined ? { effort: pin.effort } : {}),
        });
        return [described.label, described.accountLabel].filter((part) => part !== undefined && part !== ``).join(` · `);
    }),
);

/* WHETHER AN ACCOUNT MAY BE PINNED AT ALL, which a ladder can take away. An account id is one provider's store
 * key — it is only meaningful beside that provider, the same way a model id is — so it can only be pinned while
 * every rung agrees about which provider that is. Cross providers and the pin would name an account the winning
 * rung's provider has never heard of, so the field is cleared and the daemon falls back to the connected account
 * with the most headroom, which is the better answer for unwatched work in any case. The scheduler applies the
 * identical rule, so what is stored and what is spent cannot disagree. */
const accountPinnable = computed(() => new Set(form.models.map((pin) => pin.provider)).size <= 1);

// The picker hangs off the row that opened it: a popover on desktop, a sheet on mobile, the host decides. A
// function ref rather than one shared element, because each rung is edited over its own row.
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
    // The picker also settles the account, and it is the automation's rather than the rung's — but only while
    // one provider owns the whole ladder (see `accountPinnable`), so it is dropped the moment that stops.
    form.account = accountPinnable.value ? (next.account ?? ``) : ``;
};

// A new rung is added by opening the picker on the slot past the end: there is no such thing as a half-chosen
// entry, so nothing is appended until the picker actually settles on a model.
const addRung = (): Promise<void> => editRung(form.models.length);

const removeRung = (index: number): void => {
    form.models = form.models.filter((_, at) => at !== index);
    // Taking the last one out is the moment the requirement becomes relevant, so the message appears then
    // rather than only when a save is refused.
    markTouched(`models`);
    if (!accountPinnable.value) {
        form.account = ``;
    }
};

// Order is what the daemon walks, so it is edited directly rather than by drag: one step per press, which is
// also the only interaction that works the same on a phone.
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
                            <input v-model="form.channelId" :placeholder="listenerSource.channel.placeholder" class="font-mono" :class="ui.input()" />
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
                    <!-- THE CLOCK ASKS, THE FLEET ANSWERS. A schedule whose evidence is this sandbox's own history
                         (the dreaming session) is worth a turn only once enough has happened, and "enough" is
                         sessions rather than nights. A due run short of the bar shows on the row as skipped, with
                         the count, which is the automation working rather than failing. -->
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
                     told about. So the rail says whose starting point the text is while it is still one. -->
                <span v-if="recipeNote" class="mt-1 text-2xs text-subtle">Starter from {{ recipeNote }}.</span>
                <span v-else-if="starterPrompt && form.prompt === starterPrompt" class="mt-1 text-2xs text-subtle">
                    {{ listenerSource.label }}'s starter, yours to rewrite.
                </span>
            </div>
            <label class="ui-field min-w-0 flex-1 cursor-text">
                <!-- IT IS A WRITING SURFACE, not a form control. What goes in it is the longest text on this
                     page by an order of magnitude: a briefing with numbered steps, the thing the whole
                     automation turns on. So it is the same field the story editor writes into (<ProseField>),
                     bare the way the acceptance panel wears it: no box, no fill, no seam — the page under the
                     words is what says "write here", and focus lights the line being written rather than a
                     rectangle around it. It grew a shell once, and the shell was the defect: the field sizes
                     itself to its own text, so the box's floor stood taller than the field inside it and the
                     focus tint — which belongs to the field — painted the first line and stopped.
                     `-mx-2` pulls the field's own padding out to the column edge so the words, not the padding,
                     align with everything above and below. `min-h-24` keeps an empty prompt worth clicking on. -->
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
                    <!-- THE LADDER, IN THE ORDER THE DAEMON WALKS IT. Row 1 is the one you want; the rest are
                         what catches it when that account has nothing left, which on a surface nobody is
                         watching is the difference between a quiet morning and a wake that never happened. -->
                    <div class="ui-field min-w-0">
                        <span class="ui-field-label">Runs on</span>
                        <div class="flex min-w-0 flex-col gap-1.5">
                            <div v-for="(label, index) in rungs" :key="index" class="flex min-w-0 items-center gap-1.5">
                                <!-- The position, said as a number: it is the whole meaning of the row's place
                                     in the list, and a list whose order matters has to show that it does. -->
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
                                <!-- The first row has nothing above it, so its button is INVISIBLE rather than
                                     absent: dropping the element shortens that row's chip by the button's
                                     width, and a vertical list whose first row ends further right than the
                                     rest reads as a mistake rather than as "this one cannot move up". -->
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
                        <!-- The one field whose error is about spending rather than syntax, so it is said where
                             it is answered rather than only on the disabled save button. -->
                        <p v-if="modelsError !== undefined && touched.has(`models`)" class="text-2xs text-danger">{{ modelsError }}</p>
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
