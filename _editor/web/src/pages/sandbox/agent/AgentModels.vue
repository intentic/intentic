<script setup lang="ts">
import { type AgentRunPin, parsePinned, quickModelKey } from "@intentic/sandbox-contract";
import { Row, RowGroup, SegmentedControl } from "@intentic/ui";
import { computed, shallowRef } from "vue";
import { useAgentRunModel } from "../../../composables/chat/agentRunModel";
import { effortLabelOf } from "../../../composables/chat/effortScale";
import { modelChoiceLabel } from "../../../composables/chat/modelPins";
import { useQuickModel } from "../../../composables/chat/quickModel";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { useSavings } from "../../../composables/sandbox/useSavings";
import AddModelButton from "./AddModelButton.vue";
import { pinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import ModelPinPicker from "./ModelPinPicker.vue";

/* EVERY MODEL CHOICE THIS SANDBOX MAKES, in one place, because "where do I set a model" may only have one
 * answer. It sits directly under the AI accounts because every row is a choice OVER them: a model pinned here
 * can never name a provider this sandbox has no credential for, which is exactly the promise a cross-sandbox
 * preference in personal Settings could not make.
 *
 * The rows are split by what the model is asked to DO, not by which feature calls it, because that is the only
 * axis on which the right answer differs. The two one-shot jobs lead, then the two that touch real work:
 *
 *   QUICK MODEL: no conversation, no tools, one string back (a commit message, a session title). An ORDERED
 *   LIST, walked top to bottom until one answers, because the failure this row actually has is a connected
 *   model that will not answer today: the account's allowance went on the chat, and one spent provider takes
 *   every one of those jobs down for hours while the others sit idle. Auto is the default and it is DERIVED,
 *   not stored: an empty list means "work it out from whatever is connected right now" (resolveQuickModels:
 *   cheapest tier first, free channel before a paid one, every connected provider in that order), so connecting
 *   an account tomorrow improves the answer by itself. Cheapest wins BECAUSE the job is small; being frontier
 *   here is not generosity, it is the wrong tool.
 *
 *   SAFETY JUDGE: the one-shot that reads a flagged command against your policy and decides whether it runs.
 *   Directly under the quick model because that chain is literally what answers while this list is empty — the
 *   fallback is legible from the row above rather than asserted. It used to live on the Safety tab beside the
 *   policy, on the argument that which model judges a command is a safety question. True, and it still cost
 *   more than it bought: a page whose subject is "which AI does which job" that quietly excludes one job
 *   teaches nobody where to look, and the Safety tab now names the model it is using in a line instead. This
 *   is the only row here that has an off switch somewhere else, so it says where.
 *
 *   AGENT RUNS: a full isolated session with tools and a worktree, started by a surface rather than by a person
 *   typing: Fix with agent on a pipeline or a deployment, a Maintenance chore, a Documentation or Acceptance
 *   run, the fix a failed pre-push check proposes. ALSO AN ORDERED LIST, for the one reason the row above is:
 *   an account that has stopped answering takes every one of those surfaces down at once, and the next entry
 *   catches it. PINNED, never derived, and THAT is the deliberate opposite of the row above: nothing here can
 *   judge whether a job is worth the frontier tier, and a wrong guess is billed in whole sessions, so an empty
 *   list falls to the composer's own pick, which keeps following the user as they change it, rather than to a
 *   ladder this page worked out. Any of those surfaces can still override the list for a single run, from the
 *   caret on the button that starts it; this is what they open on when nobody touches it.
 *
 * The chat's own model is the third tier and has no row here: it lives in the composer, where it is chosen per
 * turn and per conversation.
 *
 * EVERY ENTRY IS EDITED IN THE APP'S OWN MODEL PICKER (ModelPinPicker → the composer's ModelPicker), which is
 * what replaced the 14rem dropdown these rows used to offer and the single effort control that used to sit
 * beside the agent-run list. That control asked ONE question of a list whose entries are chosen precisely
 * because they differ — a frontier head, a cheap account under it — and a reasoning scale is a property of the
 * model, so any answer to it was off-scale for half the list. Effort, thinking, speed and the harness now
 * belong to the entry that will actually run. */

const { settings, patch } = useSandboxSettings();
const quickModel = useQuickModel();
const agentRun = useAgentRunModel();

/* THE TIER JUDGE'S OWN RECORD, the numbers the Measure state exists to produce, drawn where the switch is so
 * "switch to On once the spend history says so" points at something on the same screen instead of at a promise.
 * Thirty days, fixed: long enough for the shares to mean something, short enough that a re-fitted judge isn't
 * graded on its predecessor's verdicts forever. */
const TIER_WINDOW_DAYS = 30;
const tierWindow = computed(() => ({ from: new Date(Date.now() - TIER_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) }));
const { savings } = useSavings(tierWindow);
const tierReport = computed(() => savings.value?.tier);
const pct = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

/* THE TIER AN ENTRY WILL ACTUALLY RUN AT, clamped the way the composer clamps its own (effortScale.ts): a
 * stored `max` on a model whose scale stops at `high`, or on one whose thinking the same pin switched off,
 * would otherwise name a rung this run cannot use. The user's own pick stays stored either way, for the day the
 * longer-scaled model leads again. */
const effortLabel = (pin: AgentRunPin): string | undefined => effortLabelOf(pin.effort, pin.provider, pin.model, pin.thinking);

/* WHAT AN ENTRY SAYS ABOUT HOW IT RUNS, in one line beside its name. Only the fields actually pinned are named,
 * so an entry left at the provider's own defaults reads as just a model: the point of the line is that a
 * deliberate choice is legible from the list without opening anything, not that every field has a value. */
const knobSummary = (pin: AgentRunPin): string | undefined =>
    [
        ...(effortLabel(pin) === undefined ? [] : [effortLabel(pin)!]),
        ...(pin.thinking === undefined ? [] : [pin.thinking ? `thinking` : `no thinking`]),
        ...(pin.fast === true ? [`fast`] : []),
        ...(pin.harness === `claude-code` ? [`Claude Code`] : []),
    ].join(` · `) || undefined;

const quick = pinnedList({
    read: () => quickModel.pinned.value,
    write: (keys) => patch({ quickModel: [...keys] }),
    decode: (key) => parsePinned(key),
    encode: (pin) => quickModelKey(pin),
});

/* WHAT AN AGENT RUN OPENS ON. Pointedly not cheapest-first like the quick model's list above, because these are
 * opposite jobs: that one exists to keep a one-click helper off the frontier tier, while this one has to read a
 * failing suite, or a container log, and repair the thing.
 *
 * A LIST here for the same reason it is one above, and for no other: one connected account whose allowance went
 * on the chat this morning takes every Fix with agent, chore and documentation run in the sandbox down with it.
 * What the empty list means is where the two part company: Auto up there, and down here the composer's own
 * pick, because nothing can judge which tier a whole session is worth.
 *
 * THE ONLY LIST WHOSE ENTRIES CARRY KNOBS, and the reason is what each list's job can actually honour: the
 * quick helpers are one-shot calls the daemon deliberately runs with thinking disabled and no effort at all
 * (agent/one-shot.ts), and the cheaper-tier list names a substitution the judge makes, which never touches an
 * unattended run. A reasoning control on either would be a switch with nothing behind it. */
const runs = pinnedList({
    read: () => agentRun.pinned.value,
    write: (pins) => patch({ agentRunModels: [...pins] }),
    decode: (pin) => pin,
    encode: (pin) => pin,
    detail: knobSummary,
    knobs: true,
});

/* THE MODEL THAT READS YOUR SAFETY POLICY, stored in its own key and edited by the same four gestures as the
 * quick list above. Its floor is that list, which is why it sits under it.
 *
 * No knobs, for the same reason the quick row has none: a verdict is a one-shot the daemon runs with thinking
 * disabled and no effort at all (agent/one-shot.ts), so a reasoning control here would be a switch with nothing
 * behind it. */
const judge = pinnedList({
    read: () => settings.value?.commandJudgeModels ?? [],
    write: (keys) => patch({ commandJudgeModels: [...keys] }),
    decode: (key) => parsePinned(key),
    encode: (pin) => quickModelKey(pin),
});

// Whether anything reads this list at all. The switch is on the Safety tab, so a row that went inert with no
// explanation would read as broken rather than as unused.
const judgeOff = computed(() => settings.value?.commandJudge === `off`);

/* THE LAST ROW IS ABOUT THE CHAT, which the three above deliberately are not, and it is the only one that can
 * change what a model the user picked themselves actually runs. So it says so, and its default says nothing at
 * all: "Measure" judges every turn, records the verdict beside what the turn really cost, and moves nothing. */
const fast = pinnedList({
    read: () => settings.value?.autoFastModels ?? [],
    write: (keys) => patch({ autoFastModels: [...keys] }),
    decode: (key) => parsePinned(key),
    encode: (pin) => quickModelKey(pin),
});

/* ONE PICKER FOR THE PAGE, over whichever entry raised it, which is the shape the shell's own picker already
 * has (hostModelPicker.ts) and for the same reason: a second ask supersedes the first, because a panel still
 * open belongs to a trigger the user has already moved away from. `index` absent means ADDING, and an add draws
 * no knobs — there is nothing to configure until the entry exists, and the row it lands on opens this same
 * panel with them in it. */
const LISTS = { quick, judge, runs, fast };
const editing = shallowRef<{ id: keyof typeof LISTS; index: number | undefined; anchor: HTMLElement } | undefined>(undefined);
const openPicker = (id: keyof typeof LISTS, index: number | undefined, anchor: HTMLElement): void => {
    editing.value = { id, index, anchor };
};
const active = computed(() => (editing.value === undefined ? undefined : LISTS[editing.value.id]));
const editingPin = computed<AgentRunPin | undefined>(() => {
    const open = editing.value;
    return open?.index === undefined ? undefined : active.value?.entries.value[open.index]?.pin;
});

// A model row answers the panel's question, so it closes behind the pick (the picker's own doing); a knob row
// writes through and stays open, because those are settings of the entry rather than the answer.
const pick = (pin: AgentRunPin): void => active.value?.apply(editing.value?.index, pin);
const configure = (pin: AgentRunPin): void => {
    if (editing.value?.index !== undefined) {
        active.value?.apply(editing.value.index, pin);
    }
};

/* WHAT AUTO WOULD DO, spelled out: the same ladder the daemon would walk, named in order. It is the row's
 * whole discoverability story: a user who has never opened this page still sees which account their commit
 * messages come from and which one catches them when it runs out, and the difference between "Auto" and a list
 * they wrote themselves becomes a thing they can compare rather than a thing they have to imagine. */
const autoOrder = computed(() => quickModel.chain.value.map(modelChoiceLabel));

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
        <!-- The order is drawn IN FULL below the row, because the useful thing to know here is not that a
             default exists but which model a click is about to bill, and, the day that one is spent, which
             one catches it. A trigger 14rem wide can say one of those; the full-width area under the row can
             say all of them, numbered, in the order they will actually be tried. -->
        <Row icon="sparkles" title="Quick model" description="Fast models for automatic background tasks.">
            <template #control>
                <AddModelButton
                    label="Add a quick model"
                    :disabled="settings === undefined"
                    @open="(anchor: HTMLElement) => openPicker(`quick`, undefined, anchor)"
                />
            </template>
            <!-- Four states, in the order they matter: the list the user wrote, the list the app would use,
                 nothing to use one with, and settings still loading, which draws nothing rather than an
                 "Auto: ." with an empty ladder behind it. -->
            <template #below>
                <ModelPinList
                    v-if="quick.entries.value.length > 0"
                    :entries="quick.entries.value"
                    warn-thinking
                    @promote="quick.promote"
                    @remove="quick.remove"
                    @edit="(index: number, anchor: HTMLElement) => openPicker(`quick`, index, anchor)"
                />
                <!-- AUTO, SPELLED OUT. Naming the ladder rather than the word is what makes this row readable
                     without opening anything: you can see which account your commit messages come from and
                     which one catches it, and decide whether that order is the one you wanted. -->
                <p v-else-if="autoOrder.length > 0" class="text-2xs text-muted">
                    <span class="text-content">Auto</span>: {{ autoOrder.join(`, then `) }}. Add a model to choose the order yourself.
                </p>
                <!-- Nothing connected: the helpers are inert, which on its own reads as a broken control
                     rather than a missing account. -->
                <p v-else-if="settings !== undefined" class="text-2xs text-muted">Connect an AI account above to enable the one-click helpers.</p>
            </template>
        </Row>

        <!-- THE OTHER ONE-SHOT, and the reason it is here rather than on Safety: this page is where a model is
             chosen, without exceptions, or it is not a place anybody learns to look. Directly under the quick
             row because that row is its floor, spelled out below in the same words. -->
        <Row icon="shield" title="Safety judge" description="Which model reads your safety policy.">
            <template #control>
                <AddModelButton
                    label="Add a model for the safety judge"
                    :disabled="settings === undefined || judgeOff"
                    @open="(anchor: HTMLElement) => openPicker(`judge`, undefined, anchor)"
                />
            </template>
            <template #below>
                <div class="flex flex-col gap-2">
                    <ModelPinList
                        v-if="judge.entries.value.length > 0"
                        :entries="judge.entries.value"
                        @promote="judge.promote"
                        @remove="judge.remove"
                        @edit="(index: number, anchor: HTMLElement) => openPicker(`judge`, index, anchor)"
                    />
                    <!-- The floor, named in full rather than as the word "Auto": these verdicts are billed to
                         one of your accounts, and which one is the fact this row exists to make readable. The
                         invitation to change it is dropped while the judge is off, because the control that
                         would do it is disabled an inch away and a row may not ask for a press it just
                         refused. -->
                    <p v-else-if="autoOrder.length > 0" class="text-2xs text-muted">
                        <span class="text-content">Your quick model</span>: {{ autoOrder.join(`, then `) }}.<template v-if="!judgeOff">
                            Add a model to judge commands on a different one.</template
                        >
                    </p>
                    <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                        Connect an AI account above to give the judge something to run on. Until then every flagged command falls back to the
                        standing rule alone.
                    </p>

                    <!-- Where the switch is. This is the only row on the page whose feature can be off from
                         somewhere else, and a disabled control with no explanation is the thing a settings
                         page owes an answer for. -->
                    <p v-if="judgeOff" class="text-2xs text-subtle">
                        Nothing is judging commands at the moment, so this is not in use.
                        <RouterLink :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } }" class="text-link hover:underline"
                            >Turn the judge on</RouterLink
                        >
                        under Safety.
                    </p>
                    <!-- The one thing worth saying about the choice, and it is not "pick a cheap one": this is
                         the only automatic job whose input may have been written by whoever the agent was
                         reading. -->
                    <p v-else class="text-2xs text-subtle">
                        Worth a better model than the rest of the automatic jobs: it reads the command as data, and on a turn that has taken in
                        something from outside, that text may be arguing for its own approval.
                    </p>
                </div>
            </template>
        </Row>

        <!-- The tier above it: a real session, started for you. The surfaces it answers for are named, "agent
             runs" means nothing until you can see that the Fix button you press on a red pipeline is one of
             them, but BELOW rather than in the description, because the description column is 14rem wide and
             a five-item list read there as six lines of prose beside a one-line dropdown. The same names on
             the full-width row underneath are one line, and read as the list they are. -->
        <Row icon="bolt" title="Agent runs" description="Model tier for runs started in a worktree.">
            <template #control>
                <AddModelButton
                    label="Add a model for agent runs"
                    :disabled="settings === undefined"
                    @open="(anchor: HTMLElement) => openPicker(`runs`, undefined, anchor)"
                />
            </template>
            <template #below>
                <!-- Each entry names the tier it will run at beside the model, because that is now a property
                     of the entry: press the row to change either half. -->
                <ModelPinList
                    v-if="runs.entries.value.length > 0"
                    :entries="runs.entries.value"
                    @promote="runs.promote"
                    @remove="runs.remove"
                    @edit="(index: number, anchor: HTMLElement) => openPicker(`runs`, index, anchor)"
                />
                <!-- The floor, named. Unlike the row above there is no ladder to spell out: deliberately,
                     since nothing here can judge which tier a whole session is worth, so what this has to
                     say is simply which model answers while the list is empty, and that it follows the
                     composer. -->
                <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                    <span class="text-content">Composer default</span>: whatever your chat is set to, which keeps following it as you change it. Add a
                    model to pin these runs to a tier of their own.
                </p>
            </template>
        </Row>

        <!-- THE CHAT'S OWN TURNS, which the two rows above never touch. It is last because it is the only one
             that can override a choice the user made a second ago, and a settings page owes that ordering:
             read down and the reach grows, from jobs nobody picked a model for, to runs somebody started, to
             the conversation in front of you. -->
        <Row icon="credit-card" title="Automatic tier" description="Run simple turns on a cheaper model from the same provider.">
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

                    <div v-if="settings?.autoTier !== `off` && tierReport !== undefined" class="rounded-lg bg-canvas px-3 py-2.5">
                        <p class="flex flex-wrap items-baseline gap-x-1.5">
                            <span class="text-sm font-semibold tabular-nums text-content">{{ tierReport.fast }}</span>
                            <span class="min-w-0 text-2xs text-muted">
                                of {{ tierReport.judged }} turns judged simple<template v-if="tierReport.judged > 0">
                                    ({{ pct(tierReport.fast, tierReport.judged) }})</template
                                >
                                · last {{ TIER_WINDOW_DAYS }} days
                            </span>
                        </p>
                        <p
                            v-if="tierReport.routed > 0 || tierReport.escalated > 0 || tierReport.denied > 0"
                            class="mt-1 text-2xs tabular-nums text-subtle"
                        >
                            <template v-if="tierReport.routed > 0">{{ tierReport.routed }} down-routed</template
                            ><template v-if="tierReport.escalated > 0"
                                ><template v-if="tierReport.routed > 0"> · </template>{{ tierReport.escalated }}/{{ tierReport.fast }} bumped
                                up</template
                            ><template v-if="tierReport.denied > 0"> · {{ tierReport.denied }} vetoed</template>
                        </p>
                    </div>

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
                                    @open="(anchor: HTMLElement) => openPicker(`fast`, undefined, anchor)"
                                />
                            </div>
                        </div>
                        <ModelPinList
                            v-if="fast.entries.value.length > 0"
                            :entries="fast.entries.value"
                            @promote="fast.promote"
                            @remove="fast.remove"
                            @edit="(index: number, anchor: HTMLElement) => openPicker(`fast`, index, anchor)"
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
