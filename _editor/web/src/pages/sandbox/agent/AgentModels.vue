<script setup lang="ts">
import { MODEL_ROLE_BLOCKS, MODEL_ROLES, type ModelPin, type ModelRole, modelPinKey, parsePinned } from "@intentic/sandbox-contract";
import { Button, Row, RowGroup, SegmentedControl, Verdict } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed, ref, shallowRef } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { useSavings } from "../../../composables/sandbox/useSavings";
import AddModelButton from "./AddModelButton.vue";
import { type PinnedList, pinKnobSummary, pinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import ModelPinPicker from "./ModelPinPicker.vue";
import ModelRoleRow from "./ModelRoleRow.vue";

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
 * FOUR GROUPS, AND THE CATALOG DECIDES WHICH IS WHICH. Eighteen jobs on one surface is a table, not a page:
 * one unbroken run of rows with no landmark to say where you are in it or which rows are like the one you came
 * for. The blocks are declared upstairs (MODEL_ROLE_BLOCKS) rather than assembled here, so they are the
 * distinctions the table ALREADY makes — a one-shot against a whole session, and a session your click starts
 * against one that starts without you — rather than a second taxonomy this file would have to keep in step. The
 * page's job is to draw them; a role added to the catalog joins the right group by saying what it is.
 *
 * AND THE ORDER OF THE GROUPS IS REACH, which is the argument the single list used to make in prose: jobs
 * nobody picked a model for come first, because they run constantly and their bill turns up without a click;
 * then the sessions somebody presses for; then the sessions that fire on their own, which are the ones an owner
 * is least likely to be watching and most likely to want held to a budget; then automatic tier, the only
 * setting here that can override a model chosen a second ago. The chat's own model is not on this page at all:
 * it lives in the composer, where it is chosen per turn and per conversation.
 *
 * THE ROWS ARE SELECTABLE, and that is the honest cost of a true per-job model being paid back. The commonest
 * thing anyone wants to say — "all of these, on this model, at this tier" — took one trip through the same
 * panel PER JOB, and the catalog grows (a role added to the table appears here by existing, which is the
 * point). That is a UI problem rather than a modelling one, and it is solved on top of the true model rather
 * than by collapsing it: tick the jobs, open ONE picker, and the model and its tier land on every one of them
 * (see `applyToSelection`). The grouping the page threw away was a fixed guess about which jobs belong
 * together; a selection is the same saving made by the person who knows.
 *
 * AN EMPTY ROW IS THE JOB AT ITS FLOOR, AND NOTHING IS RECOMMENDED FOR IT. A one-shot row used to read
 * "Auto: Gemini 3 Flash Lite, then Claude Haiku 4.5, then …" — a ladder derived from whatever happened to be
 * connected, re-ranking itself the day an account was added, spending accounts the owner had connected for
 * something else. It was presented as discoverability and it was really a default nobody chose. Now a row with
 * no models says so in a word: a one-shot with none is `off` and does not run, a whole session with none opens
 * on the model the owner picked for their own chat. Both are chips beside the name rather than the two-line
 * paragraphs they used to be — <ModelRoleRow> says why.
 *
 * EVERY ENTRY IS EDITED IN THE APP'S OWN MODEL PICKER (ModelPinPicker → the composer's ModelPicker), which is
 * what replaced the 14rem dropdown these rows used to offer and the single effort control that used to sit
 * beside the agent-run list. That control asked ONE question of a list whose entries are chosen precisely
 * because they differ — a frontier head, a cheap account under it — and a reasoning scale is a property of the
 * model, so any answer to it was off-scale for half the list. Effort, thinking, speed and the harness now
 * belong to the entry that will actually run, on every row. */

const { settings, patch } = useSandboxSettings();
const loaded = computed(() => settings.value !== undefined);

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

/* THE GROUPS, EACH WITH ITS ROWS' EDITORS ATTACHED. Built once: the editors close over the settings ref, so
 * they stay live without being rebuilt, and the block a role sits in is the catalog's answer rather than a
 * filter kept in step here. */
const blocks = MODEL_ROLE_BLOCKS.map((block) => ({
    ...block,
    rows: block.roles.map((role) => ({ role, list: editorFor(role.id) })),
}));

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
 * write; the catalog is a couple of dozen rows at most, so `includes` is cheaper than the reactivity a Set proxy
 * costs. It is per-visit state and deliberately not persisted: a selection is a gesture in progress, and one
 * restored from last week would have the next pick land on jobs nobody is looking at. */
const ROLE_IDS = MODEL_ROLES.map((role) => role.id) as readonly ModelRole[];
const selected = ref<readonly ModelRole[]>([]);
const isSelected = (role: ModelRole): boolean => selected.value.includes(role);
const selectRole = (role: ModelRole, on: boolean): void => {
    selected.value = on ? [...selected.value.filter((held) => held !== role), role] : selected.value.filter((held) => held !== role);
};
// All or nothing, from the page's own bar: the master box is the whole gesture for "everything on this page
// runs on one model", which is the shape most sandboxes actually want.
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
    <div id="models" class="flex flex-col gap-6">
        <!-- THE SELECTION BAR, above every group and STUCK to the top of the scroll, because the thing it
             commands is spread over four surfaces and two screens: a control that scrolled away would mean
             scrolling back to a button you cannot see from the row you just ticked.
             IT IS THE PAGE'S, NOT A GROUP'S. It used to ride the single group's header (<RowGroup sticky>),
             which was right while there was one group; with four, that header would either duplicate the verbs
             on every surface or scope them to a block, and a selection that spans blocks is the commonest one
             there is — "everything on this page, on one model" is the whole gesture.
             IT REPLACED A FLOATING PILL over the canvas, which answered the same reach problem and was the
             wrong answer twice over: a toolbar on a page that has no toolbar, and one that parks itself over
             the last row for as long as a selection is live. This sits in the flow, so nothing is covered and
             nothing moves when a selection starts.
             NOT ON A PHONE, with the ticks it commands. The mark column is a job's glyph there and never a
             box: a bulk edit is not a gesture anybody performs on a 390px screen, and every row still sets its
             own model. What is withheld is the shortcut. -->
        <div class="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 bg-canvas px-1 py-2 max-md:hidden">
            <label class="flex cursor-pointer items-center gap-2 text-2xs text-muted">
                <Checkbox
                    :model-value="allSelected"
                    :indeterminate="someSelected"
                    binary
                    size="small"
                    aria-label="Select every job"
                    @update:model-value="(value: unknown) => selectAll(value === true)"
                />
                <span>{{ selected.length > 0 ? `${selected.length} selected` : `Select jobs` }}</span>
            </label>
            <!-- The verbs appear WITH a selection rather than sitting greyed: there is nothing to act on until
                 something is ticked, and a disabled pair of buttons is furniture on every other visit to this
                 page. The first carries its own element up as the panel's anchor, the same contract
                 <AddModelButton> has. -->
            <template v-if="selected.length > 0">
                <Button
                    size="small"
                    label="Set a model for all…"
                    :disabled="!loaded"
                    @click="(event: MouseEvent) => openBulkPicker(event.currentTarget as HTMLElement)"
                />
                <!-- Emptying is the other half of the vocabulary, and with an empty list meaning "off" it is how
                     a sandbox switches several jobs off at once. -->
                <Button size="small" severity="danger" text label="Clear models" :disabled="!loaded" @click="clearSelection" />
            </template>
        </div>

        <!-- ONE GROUP PER BLOCK, from the catalog. The heading and the line under it are the block's own, so a
             group cannot end up describing a set of rows it no longer holds. -->
        <RowGroup v-for="block in blocks" :key="block.id" :label="block.label" :count="block.rows.length" :caption="block.caption">
            <ModelRoleRow
                v-for="row in block.rows"
                :key="row.role.id"
                :role="row.role"
                :icon="row.role.icon"
                :list="row.list"
                :selected="isSelected(row.role.id)"
                :disabled="!loaded || (row.role.id === JUDGE && judgeOff)"
                :loaded="loaded"
                @select="(on: boolean) => selectRole(row.role.id, on)"
                @open="(index: number | undefined, anchor: HTMLElement) => openRowPicker(row.list, index, anchor)"
            >
                <!-- THE SLOT IS OFFERED TO ONE ROW IN EIGHTEEN, and the `v-if` is on the <template> so the other
                     seventeen are handed no slot at all rather than an empty one: a slot that exists but renders
                     nothing still opens the block under the row, which is 12px of dead space per row on a page
                     whose whole point this round was to stop spending lines on nothing. -->
                <template v-if="row.role.id === JUDGE" #note>
                    <!-- Where the switch is. This is the only row on the page whose feature can be off from
                         somewhere else, and a disabled control with no explanation is the thing a settings page
                         owes an answer for. -->
                    <p v-if="judgeOff" class="text-2xs text-subtle">
                        Nothing is judging commands at the moment, so this is not in use.
                        <RouterLink
                            :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }"
                            class="text-link hover:underline"
                            >Turn the judge on</RouterLink
                        >
                        under Safety.
                    </p>
                    <!-- The one thing worth saying about this choice, and it is not "pick a cheap one": of every
                         job on this page, the judge is the only one whose input may have been written by
                         whoever the agent was reading. -->
                    <p v-else class="text-2xs text-subtle">
                        Worth a better model than the rest of the automatic jobs: it reads the command as data, and on a turn that has taken in
                        something from outside, that text may be arguing for its own approval.
                    </p>
                </template>
            </ModelRoleRow>
        </RowGroup>

        <!-- THE CHAT'S OWN TURNS, which no job above ever touches, and the reason this is a group of its own
             rather than a nineteenth row: it is not a job, so it is not selectable, and inside a list of ticked
             rows it had to hold the selection column open with an invisible box to keep its mark in line. A
             heading says what that hack was trying to say. It is LAST because it is the only setting here that
             can override a choice the user made a second ago, and a settings page owes that ordering: read down
             and the reach grows, from jobs nobody picked a model for, to runs somebody started, to the
             conversation in front of you. -->
        <RowGroup label="Cheaper turns" caption="Not a job: a substitution made inside a turn you started.">
            <Row spine title="Automatic tier" description="Run simple turns on a cheaper model from the same provider.">
                <!-- ITS MARK IS THE SAME BOX THE JOB ROWS DRAW, and it is a `#lead` rather than the `icon` prop
                     for exactly that reason: a bare glyph measures the tier's type size (15px) where a job's
                     mark measures the tier's `mark` (22px), so this row's title landed 8px left of every title
                     above it and the page's one text column stepped sideways in its last group. Measured, not
                     guessed. No tick, because this is not a job and cannot be selected. -->
                <template #lead="{ mark }">
                    <span class="flex shrink-0 items-center justify-center" :style="{ width: `${mark}px`, height: `${mark}px` }">
                        <Icon name="credit-card" aria-hidden="true" class="text-sm text-subtle" />
                    </span>
                </template>
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
                             surface of its own: the row's `#below` is already inside the row's hairline, and a
                             fill here would split the setting down a colour change. See <Verdict>. -->
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
                                        :disabled="!loaded"
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
                            <p v-else-if="loaded" class="text-2xs text-muted">
                                <span class="text-content">Auto</span>: cheapest from the chat's provider.
                            </p>
                        </div>
                    </div>
                </template>
            </Row>
        </RowGroup>
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
