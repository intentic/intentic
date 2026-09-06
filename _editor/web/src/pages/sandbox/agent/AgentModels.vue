<script setup lang="ts">
import { MODEL_ROLES, type ModelPin, type ModelRole, type ModelRoleSpec, modelPinKey, parsePinned } from "@intentic/sandbox-contract";
import { Button, type IconName, Row, RowGroup, SegmentedControl, Verdict } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import Checkbox from "primevue/checkbox";
import { computed, ref, shallowRef } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { useSavings } from "../../../composables/sandbox/useSavings";
import AddModelButton from "./AddModelButton.vue";
import { type PinnedList, pinKnobSummary, pinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import ModelPinPicker from "./ModelPinPicker.vue";

/* EVERY MODEL CHOICE THIS SANDBOX MAKES, in one place, because "where do I set a model" may only have one
 * answer. It sits directly under the AI accounts because every row is a choice OVER them: a model pinned here
 * can never name a provider this sandbox has no credential for, which is exactly the promise a cross-sandbox
 * preference in personal Settings could not make.
 *
 * ONE ROW PER JOB, DRAWN FROM THE CONTRACT'S OWN CATALOG (model-roles.ts). The page used to hold four rows
 * grouped by how hard the work was assumed to be — a "quick model" for the small automatic jobs, an "agent
 * runs" tier for the big ones, plus two that already named a job. That grouping was a guess about work its
 * owner knows better, and it was a guess there was no way to talk around: pinning Opus to get better commit
 * subjects also pinned it to every session title and every loop verdict, and one "agent runs" tier covered a
 * documentation sweep and a red production pipeline alike. A row per job is more to read than four; it is also
 * the first version of this page where the thing somebody wants to say can be said.
 *
 * AND THE LENGTH OF THAT LIST IS WHY THE ROWS ARE SELECTABLE. The honest cost of a true per-job model was that
 * the commonest thing anyone wants to say — "all of these, on this model, at this tier" — took one trip
 * through the same panel PER JOB, and the catalog grows (a role added to the table appears here by existing,
 * which is the point of drawing from it). That is a UI problem rather than a modelling one, and it is solved on
 * top of the true model rather than by collapsing it: tick the jobs, open ONE picker, and the model and its
 * tier land on every one of them (see `applyToSelection`). The grouping this page threw away was a fixed guess
 * about which jobs belong together; a selection is the same saving made by the person who knows.
 *
 * TWO BLOCKS, IN ORDER OF REACH. The one-shot helpers first: nobody picked a model for them, they run
 * constantly, and they are the ones whose bill turns up without a click. Then the whole sessions a screen
 * starts, and within those the ones somebody presses ahead of the ones that fire on their own, which are the
 * runs an owner is least likely to be watching and most likely to want held to a budget. The chat's own model
 * is not here at all: it lives in the composer, where it is chosen per turn and per conversation.
 *
 * AN EMPTY ROW IS THE JOB SWITCHED OFF, AND NOTHING IS RECOMMENDED FOR IT. A one-shot row used to read
 * "Auto: Gemini 3 Flash Lite, then Claude Haiku 4.5, then …" — a ladder derived from whatever happened to be
 * connected, re-ranking itself the day an account was added, spending accounts the owner had connected for
 * something else. It was presented as discoverability and it was really a default nobody chose. Now a row with
 * no models says so: a one-shot that has none does not run, and a whole session that has none opens on the
 * model the owner picked for their own chat, which is a choice they made rather than one this page invented.
 *
 * EVERY ENTRY IS EDITED IN THE APP'S OWN MODEL PICKER (ModelPinPicker → the composer's ModelPicker), which is
 * what replaced the 14rem dropdown these rows used to offer and the single effort control that used to sit
 * beside the agent-run list. That control asked ONE question of a list whose entries are chosen precisely
 * because they differ — a frontier head, a cheap account under it — and a reasoning scale is a property of the
 * model, so any answer to it was off-scale for half the list. Effort, thinking, speed and the harness now
 * belong to the entry that will actually run, on every row. */

const { settings, patch } = useSandboxSettings();

/* THE TIER JUDGE'S OWN RECORD, the numbers the Measure state exists to produce, drawn where the switch is so
 * "switch to On once the spend history says so" points at something on the same screen instead of at a promise.
 * Thirty days, fixed: long enough for the shares to mean something, short enough that a re-fitted judge isn't
 * graded on its predecessor's verdicts forever. */
const TIER_WINDOW_DAYS = 30;
const tierWindow = computed(() => ({ from: new Date(Date.now() - TIER_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) }));
const { savings } = useSavings(tierWindow);
const tierReport = computed(() => savings.value?.tier);
const pct = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

/* THE REPORT AS A <Verdict>, which is the shape every other measured answer in the app is drawn in: the figure,
 * what it is a figure of, and the evidence under it.
 *
 * THE SENTENCES ARE ASSEMBLED HERE rather than in the template, because written inline each needs a
 * `<template v-if>` mid-sentence and the whitespace gymnastics that go with it (`}}<template …></template\n>·`)
 * — which is unreadable, and one stray newline away from printing a space before a middot. */
const tierUnit = computed<string>(() => {
    const report = tierReport.value;
    if (report === undefined) {
        return ``;
    }
    const share = report.judged > 0 ? ` (${pct(report.fast, report.judged)})` : ``;
    return `of ${report.judged} turns judged simple${share} · last ${TIER_WINDOW_DAYS} days`;
});
/* What became of those judgements. Empty when nothing has happened yet, which <Verdict> reads as absent: a row
 * of zeroes is a claim that three things were measured and came to nothing, and none of them were measured. */
const tierEvidence = computed<string>(() => {
    const report = tierReport.value;
    if (report === undefined) {
        return ``;
    }
    return [
        report.routed > 0 ? `${report.routed} down-routed` : undefined,
        report.escalated > 0 ? `${report.escalated}/${report.fast} bumped up` : undefined,
        report.denied > 0 ? `${report.denied} vetoed` : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
});

/* THE ONE WRITE PATH FOR EVERY ROLE LIST ON THIS PAGE, and it sends the WHOLE record every time, because the
 * settings patch merges at the TOP level only: a row that sent its own key alone would drop every other role's
 * list with it. The bulk editor below writes several keys through this same call, in one patch, so a selection
 * of nine jobs is one save rather than nine racing ones. */
const writeRoles = (next: Partial<Record<ModelRole, ModelPin[]>>): void => patch({ modelRoles: { ...settings.value?.modelRoles, ...next } });

const listOf = (role: ModelRole): readonly ModelPin[] => settings.value?.modelRoles[role] ?? [];

/* ONE EDITOR PER ROLE, BUILT FROM THE CATALOG rather than written out. Every row stores the same thing — an
 * ordered list of pins under settings.modelRoles[role] — so the only per-row facts left are the ones the
 * catalog already holds, and a role added there gets a working row here by existing. */
const editorFor = (role: ModelRole): PinnedList =>
    pinnedList({
        read: () => listOf(role),
        write: (pins) => writeRoles({ [role]: [...pins] }),
        decode: (pin) => pin,
        encode: (pin) => pin,
        detail: pinKnobSummary,
        knobs: true,
    });

/* The catalog's glyph, narrowed. It crosses the wire as an OPEN string, like every other icon this app takes
 * from a declaration (a manifest's, an Activation's), so it is checked rather than asserted and a name this
 * build's icon set does not carry falls back rather than rendering nothing. */
const iconOf = (role: ModelRoleSpec): IconName => (isIconName(role.icon) ? role.icon : `sparkles`);

const rows = MODEL_ROLES.map((role) => ({ role: role as ModelRoleSpec, icon: iconOf(role), list: editorFor(role.id) }));
const helperRows = rows.filter((row) => row.role.kind === `helper`);
const runRows = rows.filter((row) => row.role.kind === `run`);

/* THE ONE ROW WHOSE FEATURE CAN BE OFF FROM SOMEWHERE ELSE, and the two sentences it owes because of it.
 *
 * A special case in a page otherwise drawn entirely from a table, and it earns that: the judge is the only job
 * here with a switch of its own (settings.commandJudge, on the Safety tab), so its row can go inert while every
 * neighbour stays live. A disabled control with no explanation is the thing a settings page owes an answer for,
 * and a row may not ask for a press it has just refused — so while the judge is off the row says so and points
 * at the switch instead of inviting a pin.
 *
 * The second sentence is about the CHOICE rather than the switch, and it belongs here rather than only on
 * Safety because this is where the choice is made: of every job on this page, the judge is the one whose input
 * may have been written by whoever the agent was reading. */
const JUDGE = `safety-judge`;
const judgeOff = computed(() => settings.value?.commandJudge === `off`);

/* THE CHEAPER-TIER LIST, the one model setting here that is NOT a role and should not become one. It names a
 * substitution automatic tier selection makes on a turn the user started themselves, so it is a property of
 * that feature rather than a job of its own — and it stores `${provider}:${model}` keys, without knobs, because
 * the turn it substitutes into already carries its own effort. */
const fast = pinnedList({
    read: () => settings.value?.autoFastModels ?? [],
    write: (keys) => patch({ autoFastModels: [...keys] }),
    decode: (key) => parsePinned(key),
    encode: (pin) => modelPinKey(pin),
});

/* ═══ SETTING SEVERAL JOBS AT ONCE ═══
 *
 * WHAT IS TICKED, as an ordered list rather than a Set, because it is also read as "how many" and iterated to
 * write; the catalog is a couple of dozen rows at most, so `includes` is cheaper than the reactivity a Set proxy costs. It is
 * per-visit state and deliberately not persisted: a selection is a gesture in progress, and one restored from
 * last week would have the next pick land on jobs nobody is looking at. */
const ROLE_IDS = MODEL_ROLES.map((role) => role.id) as readonly ModelRole[];
const selected = ref<readonly ModelRole[]>([]);
const isSelected = (role: ModelRole): boolean => selected.value.includes(role);
const selectRole = (role: ModelRole, on: boolean): void => {
    selected.value = on ? [...selected.value.filter((held) => held !== role), role] : selected.value.filter((held) => held !== role);
};
// All or nothing, from the group's own header: the master box is the whole gesture for "everything on this
// page runs on one model", which is the shape most sandboxes actually want.
const allSelected = computed(() => selected.value.length === ROLE_IDS.length);
const someSelected = computed(() => selected.value.length > 0 && !allSelected.value);
const selectAll = (on: boolean): void => {
    selected.value = on ? [...ROLE_IDS] : [];
};

/* THE PIN THE OPEN BULK PANEL HAS WRITTEN, or undefined before it has written one. It is what turns a bulk
 * add into an entry the picker can draw its KNOBS for: the footer only appears over a pin that exists
 * (ModelPinPickerBody), and "the model plus its tier, for all of these" is the whole point of the gesture, so
 * the model lands first and the panel stays up on it. */
const bulkPin = shallowRef<ModelPin | undefined>(undefined);

/* Models already written into EVERY selected job, which is the only honest reading of "already taken" for a
 * selection: one that is in some of the lists and not others still has somewhere to land, and greying it out
 * would refuse a press that would have done something. */
const sharedTaken = computed<readonly string[]>(() => {
    const lists = selected.value.map((role) => listOf(role).map((pin) => modelPinKey(pin)));
    return lists.length === 0 ? [] : lists.reduce((shared, keys) => shared.filter((key) => keys.includes(key)));
});

/* ONE JOB'S LIST WITH THIS PIN IN IT, which is an UPSERT rather than an append, in three cases and in this
 * order:
 *   - `replacing` is the pin this same panel wrote a moment ago, and a second pick supersedes the first: the
 *     user is re-pointing the entry they just made, exactly as pressing a row and picking again re-points that
 *     one. Dropped first, so re-pointing never leaves the abandoned model behind in nine lists.
 *   - an entry already naming this model is written THROUGH, keeping its place in the order, so a tier chosen
 *     in the panel lands on the entry rather than beside it as a duplicate.
 *   - otherwise it joins the end of the order, which is what adding means everywhere else on this page. */
const withPin = (list: readonly ModelPin[], pin: ModelPin, replacing: ModelPin | undefined): ModelPin[] => {
    const key = modelPinKey(pin);
    const kept =
        replacing === undefined || modelPinKey(replacing) === key ? list : list.filter((held) => modelPinKey(held) !== modelPinKey(replacing));
    const at = kept.findIndex((held) => modelPinKey(held) === key);
    return at === -1 ? [...kept, pin] : kept.map((held, index) => (index === at ? pin : held));
};

// Every ticked job, written together, so a selection of nine is one save rather than nine racing ones: the
// settings patch merges at the top level, so nine separate writes would each carry a record read before the
// last one landed.
const acrossSelection = (listFor: (role: ModelRole) => ModelPin[]): void =>
    writeRoles(Object.fromEntries(selected.value.map((role) => [role, listFor(role)])) as Partial<Record<ModelRole, ModelPin[]>>);

// The model, and every knob turned after it, onto every ticked job.
const applyToSelection = (pin: ModelPin): void => {
    const replacing = bulkPin.value;
    bulkPin.value = pin;
    acrossSelection((role) => withPin(listOf(role), pin, replacing));
};

/* EMPTYING THE TICKED JOBS, which is a real gesture now rather than a destructive convenience: an empty list
 * is a one-shot switched off and a session handed back to the composer, so this is how a sandbox says "stop
 * choosing models for these" in one press instead of one per job. No confirmation, for the same reason removing
 * the last entry of one row needs none — the models are named on screen and adding them back is the gesture
 * beside it. */
const clearSelection = (): void => acrossSelection(() => []);

/* ═══ THE ONE PICKER ═══
 *
 * ONE PANEL FOR THE PAGE, over whichever entry raised it, which is the shape the shell's own picker already
 * has (hostModelPicker.ts) and for the same reason: a second ask supersedes the first, because a panel still
 * open belongs to a trigger the user has already moved away from.
 *
 * WHAT IT IS OPEN OVER is a TARGET rather than a (list, index) pair, and that is what lets one panel serve two
 * gestures that answer differently. A row's target writes one entry of one list; the selection's target writes
 * one pin across every ticked job. Both are read LIVE — `pin` and `taken` are functions, not values — because
 * a knob written through the panel changes the entry underneath it, and a panel redrawing the value it opened
 * with would show the tier the user just moved away from. */
interface PickerTarget {
    readonly anchor: HTMLElement;
    readonly header: string;
    readonly knobs: boolean;
    readonly pin: () => ModelPin | undefined;
    readonly taken: () => readonly string[];
    // Answers the panel's question: a model row picked from the list.
    readonly apply: (pin: ModelPin) => void;
    // Writes a knob through. Distinct from `apply` only for a row being ADDED to, which has no entry to
    // configure until the pick has made one.
    readonly configure: (pin: ModelPin) => void;
    /* Whether the panel survives its own answer. A row's does not — the pick IS the answer, and the entry it
     * made opens the same panel again with its knobs in it. The selection's does, because the tier is the
     * other half of one gesture and cannot be drawn until there is an entry to draw it for. */
    readonly stayOpen: boolean;
}

const editing = shallowRef<PickerTarget | undefined>(undefined);
const editingPin = computed<ModelPin | undefined>(() => editing.value?.pin());
const editingTaken = computed<readonly string[]>(() => editing.value?.taken() ?? []);

const openRowPicker = (list: PinnedList, index: number | undefined, anchor: HTMLElement): void => {
    editing.value = {
        anchor,
        header: index === undefined ? `Add a model` : `Model`,
        knobs: list.knobs,
        pin: () => (index === undefined ? undefined : list.entries.value[index]?.pin),
        taken: () => list.taken.value,
        apply: (pin) => list.apply(index, pin),
        configure: (pin) => {
            if (index !== undefined) {
                list.apply(index, pin);
            }
        },
        stayOpen: false,
    };
};

const openBulkPicker = (anchor: HTMLElement): void => {
    bulkPin.value = undefined;
    editing.value = {
        anchor,
        // The header is the safeguard against the one mistake this panel can make: it looks exactly like the
        // one a single row opens, and a pick from it spends across nine jobs.
        header: `Model for ${selected.value.length} ${selected.value.length === 1 ? `job` : `jobs`}`,
        knobs: true,
        pin: () => bulkPin.value,
        taken: () => sharedTaken.value,
        apply: applyToSelection,
        configure: applyToSelection,
        stayOpen: true,
    };
};

/* THE ONE-SHOT SWALLOWED CLOSE. The picker's body answers a model row by emitting `pick` and then `close`,
 * which is right for every row on this page and wrong for the selection, whose gesture is not finished at the
 * model. So a target that says `stayOpen` arms this, and the close that arrives on the same tick is swallowed
 * once — every other close (the ×, a press outside, the next trigger) still lands. */
let swallowClose = false;
const pick = (pin: ModelPin): void => {
    const target = editing.value;
    if (target === undefined) {
        return;
    }
    target.apply(pin);
    swallowClose = target.stayOpen;
};
const configure = (pin: ModelPin): void => editing.value?.configure(pin);
const setPickerOpen = (open: boolean): void => {
    if (open) {
        return;
    }
    if (swallowClose) {
        swallowClose = false;
        return;
    }
    editing.value = undefined;
    bulkPin.value = undefined;
};

/* Three states, in the order they escalate, and the middle one is the point of the control rather than a
 * halfway house: nobody can name a sensible cutoff for "easy enough" before there is traffic to fit it against,
 * so measuring first is how the third state stops being a guess. Worded for what each DOES, not for what it is
 * called internally: "Measure" is the honest name for a mode whose whole content is that nothing happens. */
const autoTierOptions = [
    { label: `Off`, value: `off` },
    { label: `Measure`, value: `shadow` },
    { label: `On`, value: `on` },
];

/* THE ONE DIAL, and it is named rather than numbered: the cutoff behind it is meaningless to anybody who has
 * not read the weights, while these three are sentences somebody can have an opinion about. Offered in both
 * live states, not only On, because it changes what MEASURE counts too, which is the whole point of measuring:
 * try a stop, read the share it produces, then decide whether to act on it. */
const eagernessOptions = [
    { label: `Cautious`, value: `cautious` },
    { label: `Balanced`, value: `balanced` },
    { label: `Eager`, value: `eager` },
];
</script>

<template>
    <!-- `id` so the chat can send someone straight here: the model picker's "Turn it off for every chat" is the
         only route out of automatic tier selection that reaches beyond one conversation, and a link that lands
         on the top of a long settings page has not answered the question that was asked. -->
    <RowGroup id="models" label="Models">
        <!-- ALL OF THEM, FROM THE GROUP'S OWN HEADER. It is the master of the ticks below and sits where a
             master belongs, above them; it is also the discovery path for the whole gesture, since a reader
             who has not noticed a quiet box beside a row's own control will read this line.
             NOT ON A PHONE, with the ticks it commands. The row's trailing cluster is `shrink-0`, so every
             control in it is taken out of the DESCRIPTION's width — and this page's description column is
             already the thing that gave way when the Add button was narrowed for a 390px screen
             (<AddModelButton>). Measured there, one 18px box costs the blurb 24px and two more wrapped lines,
             on every row in the catalog, to offer a bulk edit nobody performs on a phone. Every row still sets its
             own model; what is withheld is the shortcut. -->
        <template #actions>
            <label class="flex cursor-pointer items-center gap-2 text-2xs text-muted max-md:hidden">
                <Checkbox
                    :model-value="allSelected"
                    :indeterminate="someSelected"
                    binary
                    size="small"
                    class="ui-checkbox-quiet"
                    aria-label="Select every job"
                    @update:model-value="(value: unknown) => selectAll(value === true)"
                />
                <span>{{ selected.length > 0 ? `${selected.length} selected` : `Select jobs` }}</span>
            </label>
        </template>

        <!-- THE ONE-SHOT JOBS. No conversation, no tools, one string back, and nobody picked a model for any of
             them, which is why they lead: they run constantly and their bill turns up without a click.

             THE SPINE FOLLOWS THE CONTENT: a pinned LIST is a block belonging to this row and hangs off its
             name; a one-line fallback is prose continuing the description, and every other explanatory `#below`
             in the app is flush. Drawn beside a single line the rule is a 14px stub that reads as a tick mark
             rather than as a spine, which is worse than no rule at all. <Row>'s `spine` says the same thing in
             general terms. -->
        <Row
            v-for="row in helperRows"
            :key="row.role.id"
            :spine="row.list.entries.value.length > 0"
            :icon="row.icon"
            :title="row.role.label"
            :description="row.role.blurb"
        >
            <!-- THE TICK RIDES WITH THE ROW'S CONTROL RATHER THAN LEADING THE ROW, which is the opposite of
                 where a multi-select column usually goes and was arrived at by looking at both. In the lead it
                 pushes the whole page: `#below` is full-width by <Row>'s contract, so every one-line state
                 ("Not set: …", "Composer default: …") — which on a fresh sandbox is every row on the page —
                 ends up starting two marks left of the title it belongs to and reads as a footnote on the
                 card. Turning the spine on to fix that is worse still: the spine centres on the WHOLE lead
                 cluster, so with two marks in it the rule lands in the gap between them, under neither.
                 Here it costs the page no geometry at all, and it sits beside the control it modifies. -->
            <template #control>
                <Checkbox
                    :model-value="isSelected(row.role.id)"
                    binary
                    size="small"
                    class="ui-checkbox-quiet max-md:hidden"
                    :aria-label="`Select ${row.role.label.toLowerCase()}`"
                    @update:model-value="(value: unknown) => selectRole(row.role.id, value === true)"
                />
                <AddModelButton
                    :label="`Add a model for ${row.role.label.toLowerCase()}`"
                    :disabled="settings === undefined || (row.role.id === JUDGE && judgeOff)"
                    @open="(anchor: HTMLElement) => openRowPicker(row.list, undefined, anchor)"
                />
            </template>
            <!-- Two states: the list the user wrote, and the job being off because they wrote none. Settings
                 still loading draws neither rather than announcing an "off" it has not read yet. -->
            <template #below>
                <div class="flex flex-col gap-2">
                    <ModelPinList
                        v-if="row.list.entries.value.length > 0"
                        :entries="row.list.entries.value"
                        note-thinking
                        @promote="row.list.promote"
                        @remove="row.list.remove"
                        @edit="(index: number, anchor: HTMLElement) => openRowPicker(row.list, index, anchor)"
                    />
                    <!-- NOT SET, SAID PLAINLY. This row used to spell out an "Auto" ladder derived from whatever
                         was connected, on the argument that naming it was the discoverability story for a
                         setting nobody had opened. What it was really doing was choosing: a job nobody had
                         configured still spent an account, on an order this app invented, which changed under
                         the owner whenever an account was added. Saying nothing runs is both the honest line
                         and the one that makes the control beside it worth pressing. The invitation is dropped
                         while the judge is off, because the control that would answer it is disabled an inch
                         away and a row may not ask for a press it has just refused. -->
                    <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                        <span class="text-content">Not set</span>: this does not run, and no model is chosen for you.<template
                            v-if="row.role.id !== JUDGE || !judgeOff"
                        >
                            Add a model to switch it on.</template
                        >
                    </p>

                    <!-- Where the switch is. This is the only row on the page whose feature can be off from
                         somewhere else, and a disabled control with no explanation is the thing a settings page
                         owes an answer for. -->
                    <p v-if="row.role.id === JUDGE && judgeOff" class="text-2xs text-subtle">
                        Nothing is judging commands at the moment, so this is not in use.
                        <RouterLink :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }" class="text-link hover:underline"
                            >Turn the judge on</RouterLink
                        >
                        under Safety.
                    </p>
                    <!-- The one thing worth saying about this choice, and it is not "pick a cheap one": of every
                         job on this page, the judge is the only one whose input may have been written by
                         whoever the agent was reading. -->
                    <p v-else-if="row.role.id === JUDGE" class="text-2xs text-subtle">
                        Worth a better model than the rest of the automatic jobs: it reads the command as data, and on a turn that has taken in
                        something from outside, that text may be arguing for its own approval.
                    </p>
                </div>
            </template>
        </Row>

        <!-- THE WHOLE SESSIONS, each with tools and a worktree, started by a screen rather than by a person at a
             composer. Ordered so the ones somebody presses come before the ones that fire on their own. -->
        <Row
            v-for="row in runRows"
            :key="row.role.id"
            :spine="row.list.entries.value.length > 0"
            :icon="row.icon"
            :title="row.role.label"
            :description="row.role.blurb"
        >
            <template #control>
                <Checkbox
                    :model-value="isSelected(row.role.id)"
                    binary
                    size="small"
                    class="ui-checkbox-quiet max-md:hidden"
                    :aria-label="`Select ${row.role.label.toLowerCase()}`"
                    @update:model-value="(value: unknown) => selectRole(row.role.id, value === true)"
                />
                <AddModelButton
                    :label="`Add a model for ${row.role.label.toLowerCase()}`"
                    :disabled="settings === undefined"
                    @open="(anchor: HTMLElement) => openRowPicker(row.list, undefined, anchor)"
                />
            </template>
            <template #below>
                <!-- Each entry names the tier it will run at beside the model, because that is a property of the
                     entry: press the row to change either half. -->
                <ModelPinList
                    v-if="row.list.entries.value.length > 0"
                    :entries="row.list.entries.value"
                    @promote="row.list.promote"
                    @remove="row.list.remove"
                    @edit="(index: number, anchor: HTMLElement) => openRowPicker(row.list, index, anchor)"
                />
                <!-- The floor, named, and it is a choice the owner already made rather than one this page
                     derived: nothing here can judge what a whole session is worth, so an unset row follows the
                     composer instead of picking. -->
                <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                    <span class="text-content">Composer default</span>: whatever your chat is set to, which keeps following it as you change it. Add a
                    model to pin this job to a tier of its own.
                </p>
            </template>
        </Row>

        <!-- THE CHAT'S OWN TURNS, which no row above ever touches. It is last because it is the only one that
             can override a choice the user made a second ago, and a settings page owes that ordering: read down
             and the reach grows, from jobs nobody picked a model for, to runs somebody started, to the
             conversation in front of you. -->
        <!-- NOT A JOB, SO NOT SELECTABLE, and it needs no spacer to say so: the tick rides in the control
             cluster, which is right-aligned, so a row without one simply has one fewer control. -->
        <Row spine icon="credit-card" title="Automatic tier" description="Run simple turns on a cheaper model from the same provider.">
            <template #control>
                <SegmentedControl
                    :model-value="settings?.autoTier ?? `shadow`"
                    :options="autoTierOptions"
                    @update:model-value="(autoTier: string) => patch({ autoTier: autoTier as `off` | `shadow` | `on` })"
                />
            </template>
            <template #below>
                <div class="flex flex-col gap-3">
                    <p v-if="settings?.autoTier === `off`" class="text-2xs text-muted">Nothing is judged or recorded.</p>
                    <p v-else-if="settings?.autoTier === `on`" class="text-2xs text-muted">
                        Simple turns run on the cheaper model. Each conversation can veto it.
                    </p>

                    <!-- WHAT THE JUDGE HAS RECORDED, in the app's one shape for a measured answer and with no
                         surface of its own: the row's `#below` is already inside the row's hairline, and a fill
                         here would split the setting down a colour change. See <Verdict>. -->
                    <Verdict
                        v-if="settings?.autoTier !== `off` && tierReport !== undefined"
                        tone="content"
                        :value="`${tierReport.fast}`"
                        :unit="tierUnit"
                        :evidence="tierEvidence"
                    />

                    <div class="flex flex-col gap-1.5">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                            <span class="text-xs font-medium text-content">Cheaper model</span>
                            <div class="flex flex-wrap items-center justify-end gap-2">
                                <div v-if="settings?.autoTier !== `off`" class="flex shrink-0 items-center" role="group" aria-label="How readily">
                                    <SegmentedControl
                                        :model-value="settings?.autoTierEagerness ?? `balanced`"
                                        :options="eagernessOptions"
                                        wrap
                                        @update:model-value="
                                            (autoTierEagerness: string) =>
                                                patch({ autoTierEagerness: autoTierEagerness as `cautious` | `balanced` | `eager` })
                                        "
                                    />
                                </div>
                                <AddModelButton
                                    label="Add a model for automatic tier selection"
                                    :disabled="settings === undefined"
                                    @open="(anchor: HTMLElement) => openRowPicker(fast, undefined, anchor)"
                                />
                            </div>
                        </div>
                        <ModelPinList
                            v-if="fast.entries.value.length > 0"
                            :entries="fast.entries.value"
                            @promote="fast.promote"
                            @remove="fast.remove"
                            @edit="(index: number, anchor: HTMLElement) => openRowPicker(fast, index, anchor)"
                        />
                        <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                            <span class="text-content">Auto</span>: cheapest from the chat's provider.
                        </p>
                    </div>
                </div>
            </template>
        </Row>
    </RowGroup>

    <!-- THE SELECTION'S OWN BAR, floating rather than filed into the group's header, and that is what makes the
         gesture usable at all on a page this tall: the ticks are spread over two screens, so a control at the
         top would mean scrolling back to a button you cannot see from the row you just ticked. It follows the
         one floating bar this app already draws (the agents board's discard target) and appears only while
         there is a selection, because a permanent bar over a settings page is a toolbar for a page that has no
         tools. -->
    <div
        v-if="selected.length > 0"
        class="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-full border border-line-strong bg-card px-3 py-2 shadow-lg"
        role="group"
        aria-label="Selected jobs"
    >
        <span class="px-1 text-2xs font-medium text-content">{{ selected.length }} {{ selected.length === 1 ? `job` : `jobs` }} selected</span>
        <!-- The one press this whole feature exists for. It carries its own element up as the panel's anchor,
             the same contract <AddModelButton> has, so the picker opens over the bar rather than over a row
             that may be off screen. -->
        <Button
            size="small"
            label="Set a model for all…"
            :disabled="settings === undefined"
            @click="(event: MouseEvent) => openBulkPicker(event.currentTarget as HTMLElement)"
        />
        <!-- Emptying is the other half of the vocabulary, and with an empty list meaning "off" it is how a
             sandbox switches several jobs off at once. -->
        <Button size="small" severity="danger" text label="Clear models" :disabled="settings === undefined" @click="clearSelection" />
        <Button size="small" severity="secondary" text label="Done" aria-label="Clear the selection" @click="selectAll(false)" />
    </div>

    <!-- ONE PANEL, STANDING BY, opened over whichever trigger raised it. It is mounted rather than created per
         open because the overlay hosts inside it measure and place themselves in a watcher on that flag: a host
         that arrives already open never places, and parks off-screen (ResponsiveOverlay's header). Its CONTENT
         is what remounts per open, which is what resets the search box and refreshes the catalogs. -->
    <ModelPinPicker
        :open="editing !== undefined"
        :anchor="editing?.anchor"
        :header="editing?.header"
        :pin="editingPin"
        :knobs="editing?.knobs === true"
        :taken="editingTaken"
        @update:open="setPickerOpen"
        @pick="pick"
        @configure="configure"
    />
</template>
