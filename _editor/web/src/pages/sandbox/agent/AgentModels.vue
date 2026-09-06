<script setup lang="ts">
import { MODEL_ROLES, type ModelPin, type ModelRole, type ModelRoleSpec, modelPinKey, parsePinned } from "@intentic/sandbox-contract";
import { type IconName, Row, RowGroup, SegmentedControl, Verdict } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import { computed, shallowRef } from "vue";
import { RouterLink } from "vue-router";
import { modelChoiceLabel } from "../../../composables/chat/modelPins";
import { useRoleModel } from "../../../composables/chat/roleModel";
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
 * documentation sweep and a red production pipeline alike. Seventeen rows is more to read than four; it is also
 * the first version of this page where the thing somebody wants to say can be said.
 *
 * SIMPLICITY IS A LATER PROBLEM, DELIBERATELY. A shorter face over this — presets, "cheap everywhere",
 * "frontier everywhere" — is a thing that can be built on top of a true model and cannot be recovered from a
 * lossy one, and the configuration and the picker were already per use-case underneath. What the grouping was
 * saving was reading, and it was charging for it in choices nobody could make.
 *
 * TWO BLOCKS, IN ORDER OF REACH. The one-shot helpers first: nobody picked a model for them, they run
 * constantly, and they are the ones whose bill turns up without a click. Then the whole sessions a screen
 * starts, and within those the ones somebody presses ahead of the ones that fire on their own, which are the
 * runs an owner is least likely to be watching and most likely to want held to a budget. The chat's own model
 * is not here at all: it lives in the composer, where it is chosen per turn and per conversation.
 *
 * WHAT AN EMPTY ROW MEANS IS THE ROLE'S OWN ANSWER, and the two are genuinely different. A one-shot derives an
 * Auto ladder from whatever is connected — cheapest rung of each provider, best first — so it improves by
 * itself when an account is added and can never name a provider this sandbox has no credential for. A whole
 * session falls to the composer's own pick, because nothing can judge what a session is worth and a wrong guess
 * is billed whole. Each row says which of the two it is, in full rather than as the word "Auto": a user who has
 * never opened this page can still see which account their commit messages come from and which one catches it.
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

/* ONE EDITOR PER ROLE, BUILT FROM THE CATALOG rather than written out. Every row stores the same thing — an
 * ordered list of pins under settings.modelRoles[role] — so the only per-row facts left are the ones the
 * catalog already holds, and a role added there gets a working row here by existing.
 *
 * `patch` writes the WHOLE record back, because the settings patch merges at the TOP level only: sending one
 * role's key alone would drop every other role's list with it. */
const editorFor = (role: ModelRole): PinnedList =>
    pinnedList({
        read: () => settings.value?.modelRoles[role] ?? [],
        write: (pins) => patch({ modelRoles: { ...settings.value?.modelRoles, [role]: [...pins] } }),
        decode: (pin) => pin,
        encode: (pin) => pin,
        detail: pinKnobSummary,
        knobs: true,
    });

/* One row's whole state: what it is (the catalog's own words), the editor over its list, and the RESOLVED chain
 * the daemon would walk, which is what the empty state names. Built once for the page rather than per render,
 * because each `useRoleModel` enters a query composable and that has to happen in setup. */
/* The catalog's glyph, narrowed. It crosses the wire as an OPEN string, like every other icon this app takes
 * from a declaration (a manifest's, an Activation's), so it is checked rather than asserted and a name this
 * build's icon set does not carry falls back rather than rendering nothing. */
const iconOf = (role: ModelRoleSpec): IconName => (isIconName(role.icon) ? role.icon : `sparkles`);

const rows = MODEL_ROLES.map((role) => ({
    role: role as ModelRoleSpec,
    icon: iconOf(role),
    list: editorFor(role.id),
    resolved: useRoleModel(role.id),
}));
const helperRows = rows.filter((row) => row.role.kind === `helper`);
const runRows = rows.filter((row) => row.role.kind === `run`);

/* WHAT AUTO WOULD DO FOR THIS ROW, spelled out: the same ladder the daemon would walk, named in order. It is
 * the row's whole discoverability story — a user who has never opened this page still sees which account their
 * commit messages come from and which one catches it when it runs out, and the difference between "Auto" and a
 * list they wrote themselves becomes a thing they can compare rather than a thing they have to imagine. */
const autoOrder = (row: (typeof rows)[number]): readonly string[] => row.resolved.chain.value.map(modelChoiceLabel);

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

/* ONE PICKER FOR THE PAGE, over whichever entry raised it, which is the shape the shell's own picker already
 * has (hostModelPicker.ts) and for the same reason: a second ask supersedes the first, because a panel still
 * open belongs to a trigger the user has already moved away from. `index` absent means ADDING, and an add draws
 * no knobs — there is nothing to configure until the entry exists, and the row it lands on opens this same
 * panel with them in it.
 *
 * The open editor is held DIRECTLY rather than by a key into a table of lists: there are eighteen of them now,
 * they are built from a catalog rather than written out, and a second lookup keyed by role id would be a
 * parallel table to keep in step for no gain. */
const editing = shallowRef<{ list: PinnedList; index: number | undefined; anchor: HTMLElement } | undefined>(undefined);
const openPicker = (list: PinnedList, index: number | undefined, anchor: HTMLElement): void => {
    editing.value = { list, index, anchor };
};
const active = computed(() => editing.value?.list);
const editingPin = computed<ModelPin | undefined>(() => {
    const open = editing.value;
    return open?.index === undefined ? undefined : open.list.entries.value[open.index]?.pin;
});

// A model row answers the panel's question, so it closes behind the pick (the picker's own doing); a knob row
// writes through and stays open, because those are settings of the entry rather than the answer.
const pick = (pin: ModelPin): void => active.value?.apply(editing.value?.index, pin);
const configure = (pin: ModelPin): void => {
    if (editing.value?.index !== undefined) {
        active.value?.apply(editing.value.index, pin);
    }
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
            <template #control>
                <AddModelButton
                    :label="`Add a model for ${row.role.label.toLowerCase()}`"
                    :disabled="settings === undefined || (row.role.id === JUDGE && judgeOff)"
                    @open="(anchor: HTMLElement) => openPicker(row.list, undefined, anchor)"
                />
            </template>
            <!-- Three states, in the order they matter: the list the user wrote, the ladder the app would walk
                 instead, and nothing to walk one with. Settings still loading draws nothing rather than an
                 "Auto: ." with an empty chain behind it. -->
            <template #below>
                <div class="flex flex-col gap-2">
                    <ModelPinList
                        v-if="row.list.entries.value.length > 0"
                        :entries="row.list.entries.value"
                        note-thinking
                        @promote="row.list.promote"
                        @remove="row.list.remove"
                        @edit="(index: number, anchor: HTMLElement) => openPicker(row.list, index, anchor)"
                    />
                    <!-- AUTO, SPELLED OUT. Naming the ladder rather than the word is what makes the row readable
                         without opening anything: you can see which account this job is billed to and which one
                         catches it, and decide whether that order is the one you wanted. The invitation to
                         change it is dropped while the judge is off, because the control that would do it is
                         disabled an inch away and a row may not ask for a press it just refused. -->
                    <p v-else-if="autoOrder(row).length > 0" class="text-2xs text-muted">
                        <span class="text-content">Auto</span>: {{ autoOrder(row).join(`, then `) }}.<template
                            v-if="row.role.id !== JUDGE || !judgeOff"
                        >
                            Add a model to choose the order yourself.</template
                        >
                    </p>
                    <!-- Nothing connected: the job is inert, which on its own reads as a broken control rather
                         than as a missing account. -->
                    <p v-else-if="settings !== undefined" class="text-2xs text-muted">Connect an AI account above to enable this.</p>

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
                <AddModelButton
                    :label="`Add a model for ${row.role.label.toLowerCase()}`"
                    :disabled="settings === undefined"
                    @open="(anchor: HTMLElement) => openPicker(row.list, undefined, anchor)"
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
                    @edit="(index: number, anchor: HTMLElement) => openPicker(row.list, index, anchor)"
                />
                <!-- The floor, named. Unlike a one-shot row there is no ladder to spell out, and deliberately so:
                     nothing here can judge what a whole session is worth, so what this has to say is simply
                     which model answers while the list is empty, and that it follows the composer. -->
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
                                    @open="(anchor: HTMLElement) => openPicker(fast, undefined, anchor)"
                                />
                            </div>
                        </div>
                        <ModelPinList
                            v-if="fast.entries.value.length > 0"
                            :entries="fast.entries.value"
                            @promote="fast.promote"
                            @remove="fast.remove"
                            @edit="(index: number, anchor: HTMLElement) => openPicker(fast, index, anchor)"
                        />
                        <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                            <span class="text-content">Auto</span>: cheapest from the chat's provider.
                        </p>
                    </div>
                </div>
            </template>
        </Row>
    </RowGroup>

    <!-- ONE PANEL, STANDING BY, opened over whichever trigger raised it. It is mounted rather than created per
         open because the overlay hosts inside it measure and place themselves in a watcher on that flag: a host
         that arrives already open never places, and parks off-screen (ResponsiveOverlay's header). Its CONTENT
         is what remounts per open, which is what resets the search box and refreshes the catalogs. -->
    <ModelPinPicker
        :open="editing !== undefined"
        :anchor="editing?.anchor"
        :pin="editingPin"
        :knobs="active?.knobs === true"
        :taken="active?.taken.value ?? []"
        @update:open="editing = undefined"
        @pick="pick"
        @configure="configure"
    />
</template>
