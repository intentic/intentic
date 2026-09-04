<script setup lang="ts">
import { type ChoreVerdict, probeSpec, repoName } from "@intentic/sandbox-contract/chores";
import {
    AgentRunButton,
    type AgentRunChoice,
    Button,
    DisclosureRow,
    Icon,
    type IconName,
    StatusBadge,
    type StatusVariant,
    timeAgo,
    useAgentRunPick,
    useNow,
} from "@intentic/extension-ui";
import { host } from "./host";
import { computed, ref, watch } from "vue";
import type { MeasuringProbe } from "./useChores";
import type { ChoreRun } from "./useRuns";

/* ONE CHORE, IN ONE REPOSITORY. The row has to answer three questions in one line: what is this, is it due, and
 * has anyone looked, and then, opened, show the evidence that decided it.
 *
 * The evidence is the part that matters. A maintenance surface that says "4 things need attention" and cannot
 * show its working is a surface people stop believing on the first row that turns out to be wrong, and after that
 * they stop reading the rest. So every claim here is expandable into the specific packages, files or advisories
 * behind it, and a CLEAR chore expands too, into what was measured and when, because "there is nothing to do
 * here" is only reassuring if you can see what was checked. */

/* `showRepo` rather than a repo string, because the row already knows which repository it belongs to: what it
 * cannot know is whether the list around it spans more than one. On a list scoped to a single repository the mark
 * is the same word on every row, which is noise; across repositories it is the only thing telling two otherwise
 * identical rows apart. */
// `measuring` is the WHOLE sandbox's list rather than this row's slice: the row already knows its repository and
// which probes its chore rests on, and filtering it here is one line against a parent that would otherwise
// compute a slice per row on every poll.
const { verdict, run, measuring } = defineProps<{
    verdict: ChoreVerdict;
    run: ChoreRun | undefined;
    measuring: readonly MeasuringProbe[];
    expanded: boolean;
    showRepo: boolean;
    busy: boolean;
}>();
const emit = defineEmits<{
    toggle: [];
    start: [pick: AgentRunChoice | undefined];
    remeasure: [];
    snooze: [];
    unsnooze: [];
    open: [conversationId: string];
}>();

/* Which model this chore's turn opens on, and the caret that re-points it for this chore alone. Per ROW, because
 * a board of chores starts many runs and the tier is a judgement about the one in front of you: "look into a
 * flaky suite" and "fix a dependency bump" are not worth the same session. Seeded from the sandbox's agent-run
 * list, asked of the host so the button and the daemon cannot disagree about what a click costs. */
const runModel = useAgentRunPick(() => host().models);
const startRun = (): void => {
    emit(`start`, runModel.overridden.value ? runModel.model.value : undefined);
    runModel.clear();
};

/* WHAT IS BEING MEASURED FOR THIS ROW, right now. A chore rests on one or more probes (`needs`), and it is
 * measuring while any of them is: the evidence on screen is only replaced once they have all landed, so saying
 * "done" after the first would be the same premature claim in a smaller costume. */
const inFlight = computed(() => measuring.filter((entry) => entry.repo === verdict.repo && verdict.chore.needs.includes(entry.id)));
const busyHere = computed(() => inFlight.value.length > 0);

// The wall clock, armed only while this row has something running. A board of thirteen chores with one
// measurement between them ticks once, not thirteen times.
const now = useNow(busyHere);

/* HOW LONG IT HAS BEEN GOING, and: the part a bare spinner cannot say, whether it has started at all. The
 * runner has one lane across the whole sandbox, so a probe pressed while a jscpd sweep is mid-flight genuinely
 * waits, and a row counting up from a start that has not happened would be inventing progress. */
const elapsed = computed<string>(() => {
    const started = inFlight.value.map((entry) => entry.startedAt).filter((at) => at !== undefined);
    if (started.length === 0) {
        return `waiting for the machine`;
    }
    const seconds = Math.max(0, Math.round((now.value - Math.min(...started)) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
});

// What is actually being run, by the name the strip above uses for it: "measuring" is a spinner, "measuring
// dead code" is a fact, and the difference is whether the reader can tell a stuck row from a slow one.
const measuringWhat = computed(() => inFlight.value.map((entry) => probeSpec(entry.id).measures).join(` and `));

/* THE LANDING. A measurement that finishes silently is only half of the fix: the numbers change while the reader
 * is looking somewhere else on the page, and they are left comparing a row against their memory of it. So the
 * row keeps the headline it was carrying when the measurement started, and says what happened to it afterwards
 *: including, and especially, "nothing", which is the answer a re-measure most often has and the one a silent
 * update is least able to give. Cleared on collapse; it is an acknowledgment, not a record. */
const before = ref<string>();
const landed = ref<{ from: string; to: string }>();
watch(busyHere, (running, was) => {
    if (running) {
        before.value = verdict.headline;
        landed.value = undefined;
        return;
    }
    if (was === true && before.value !== undefined) {
        landed.value = { from: before.value, to: verdict.headline };
        before.value = undefined;
    }
});

// The state, as one badge. `unavailable` is deliberately NOT a warning colour: nothing is wrong, we simply have
// not measured it, and painting that amber would make every repo without knip look broken. `stale` is quiet for
// the same reason and one more: it is the state a row lands in BECAUSE the work got done, and a colour that reads
// as a problem would make finishing a chore look like breaking something.
const status = computed<{ variant: StatusVariant; label: string } | undefined>(() => {
    // Measuring outranks every settled state, because it is the only one that is about to stop being true, and
    // a row that reads "stale" while it is being re-measured is the exact complaint this all started as.
    if (busyHere.value) {
        return { variant: `info`, label: `measuring` };
    }
    if (verdict.state === `due`) {
        return verdict.severity === `warning` ? { variant: `warning`, label: `carrying` } : { variant: `info`, label: `due` };
    }
    if (verdict.state === `stale`) {
        return { variant: `neutral`, label: `re-measure` };
    }
    if (verdict.state === `snoozed`) {
        return { variant: `neutral`, label: `snoozed` };
    }
    if (verdict.state === `unavailable`) {
        return { variant: `neutral`, label: `unmeasured` };
    }
    return { variant: `success`, label: `clear` };
});

/* HOW OLD THE NUMBERS ARE, on the collapsed row beside the numbers themselves. Every measured state carries it,
 * not just the stale one, because the failure this prevents is general: a count from last Tuesday and a count
 * from an hour ago are different claims, they were drawn identically, and the row was the only place a reader
 * would ever look. The scope strip says the same thing per probe, but that is one line above a list of thirteen
 * and it is not what the eye is on when it reads "279 unreferenced files". */
const measured = computed<string | undefined>(() => (verdict.measuredAt === undefined ? undefined : `measured ${timeAgo(verdict.measuredAt)}`));

/* WHAT THE LAST RUN MEANS FOR THIS EVIDENCE: two sentences that were one, and had to be split because they are
 * opposite claims. "We looked again and it has not moved" is a finding; "we have not looked since" is the absence
 * of one. Both are said out loud rather than left implicit, because the alternative: a chore that silently stops
 * appearing due after a run, is how a surface loses the owner's trust in the other direction: they fix nothing,
 * the row goes quiet, and they conclude it was never real. */
const evidenceNote = computed<string | undefined>(() => {
    if (verdict.state === `stale`) {
        return run === undefined
            ? `This measurement was taken before the last turn against this chore, and nothing has measured since.`
            : `This measurement was taken before the turn that ran ${timeAgo(run.manifest.createdAt)}, and nothing has measured since.`;
    }
    return verdict.settled && run !== undefined
        ? `Re-measured since the turn that ran ${timeAgo(run.manifest.createdAt)}, and the evidence has not moved.`
        : undefined;
});

const liveAgent = computed(() => (run?.running === true ? run.manifest.conversationId : undefined));
</script>

<template>
    <!-- A @container: whether this row can hold its title and its headline on one line is a fact about the ROW,
         and the row is as wide as a workspace pane the reader can shrink to a third of the window.

         `body="drawer"`: what opens is a place of its own — a live measurement strip, the evidence tables, and
         the row's verbs under their own rule — not a fact hanging off the chore's name. -->
    <DisclosureRow
        class="@container border-t border-line/60 first:border-t-0"
        density="compact"
        body="drawer"
        :open="expanded"
        @update:open="emit(`toggle`)"
    >
        <template #lead>
            <Icon :name="verdict.chore.icon as IconName" class="shrink-0 text-subtle" />
        </template>

        <!-- ONE LINE WITH ROOM FOR IT, TWO WITHOUT. On a wide row the title keeps its full width and the
             headline takes the flexible column: truncating "4 majors waiting, 61 behind in total" to fit a
             chore name nobody needed re-reading would lose the only part that changes. In a narrow pane there
             is no column wide enough for both, and the row that tried spilled its state badge off the card, so
             the two stack, each truncating on its own line, and the badge stays where it can be read. -->
        <template #title>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5 font-normal @lg:flex-row @lg:items-center @lg:gap-3">
                <span class="@lg:shrink-0 flex min-w-0 items-center gap-2">
                    <span class="min-w-0 truncate text-content">{{ verdict.chore.title }}</span>
                    <span v-if="showRepo" class="shrink-0 rounded bg-content/5 px-1.5 py-0.5 text-2xs text-subtle">
                        {{ repoName(verdict.repo) }}
                    </span>
                </span>
                <!-- The age never truncates and the headline always does: a clipped count is still readable as a
                     count, where "measured 6 d…" is worse than not saying it. -->
                <span class="flex min-w-0 flex-1 items-baseline gap-2">
                    <span class="min-w-0 truncate text-xs text-subtle">{{ verdict.headline }}</span>
                    <span v-if="measured" class="shrink-0 text-2xs text-subtle/70">{{ measured }}</span>
                </span>
            </span>
        </template>

        <!-- Facts, not verbs, so they ride `#meta`. One spinner, whichever kind of work is in flight: a row can
             be both re-measuring and running a turn, and two spinners side by side say nothing the badge beside
             them does not. -->
        <template #meta>
            <Icon v-if="liveAgent || busyHere" name="spinner" spin class="shrink-0 text-subtle" />
            <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" class="shrink-0" />
        </template>

        <template #below>
            <div class="@lg:px-2">
                <!-- THE MEASUREMENT, WHILE IT IS HAPPENING: at the TOP of the opened row, above the evidence it is
                 replacing, because that is the reading order the reader is in: they pressed the button, and the
                 next thing they look at has to be the answer to "did that do anything". It names the tool's
                 subject, counts, and says out loud that the numbers underneath are the OLD ones: a panel that
                 leaves stale figures under a spinner is inviting them to be read as the new result. -->
                <div v-if="busyHere" class="mb-3 flex items-start gap-2 rounded-lg bg-info/10 px-3 py-2">
                    <Icon name="spinner" spin class="mt-0.5 shrink-0 text-xs text-info" />
                    <!-- Two lines, always: the caveat is a sentence in its own right, and hanging it off the end of
                     the live one on a wide pane meant it wrapped to a line beginning with a separator dot on
                     every narrower one. A pane the reader can drag to a third of the window has no wide case. -->
                    <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="flex flex-wrap items-baseline gap-x-2">
                            <span class="text-xs text-content">Measuring {{ measuringWhat }}…</span>
                            <span class="text-2xs text-subtle">{{ elapsed }}</span>
                        </span>
                        <span class="text-2xs text-subtle/70">The figures below are the ones being replaced.</span>
                    </span>
                </div>

                <!-- AND WHEN IT LANDS. Held until the row is collapsed rather than faded out on a timer: the reader
                 who pressed re-measure and then went to read something else comes back to the sentence, which is
                 the case an auto-dismissing toast serves worst. "Unchanged" is stated as loudly as a change,
                 because it is a finding: it is the whole answer to "is this row still telling the truth". -->
                <div v-else-if="landed" class="mb-3 flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2">
                    <Icon name="check-circle" class="mt-0.5 shrink-0 text-xs text-success" />
                    <!-- The claim on one line, what it found on the next: the same two-line shape as the strip
                     above, so a row that has just finished measuring reads as the sentence that replaced the
                     one before it rather than as a different kind of thing. The before/after is one wrapping
                     unit: split across lines, an arrow ends up alone at the end of a line pointing at nothing. -->
                    <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-xs text-content">Re-measured just now.{{ landed.from === landed.to ? ` Nothing changed.` : `` }}</span>
                        <span v-if="landed.from === landed.to" class="text-2xs text-subtle">{{ landed.to }}</span>
                        <span v-else class="flex flex-wrap items-baseline gap-x-1.5 text-2xs">
                            <span class="text-subtle line-through">{{ landed.from }}</span>
                            <span class="whitespace-nowrap text-content"
                                ><Icon name="arrow-right" class="text-2xs text-subtle" /> {{ landed.to }}</span
                            >
                        </span>
                    </span>
                </div>

                <p class="max-w-read text-xs text-subtle">{{ verdict.chore.description }}</p>

                <!-- THE RULE, above the evidence and phrased as what WOULD make this due, so it reads the same whether
                 the chore is due or clear. Without it a row is asking to be taken on trust; with it, the reader
                 can disagree with the rule rather than only with the number, which is the disagreement worth
                 having, and the one that improves the book. -->
                <p class="mt-3 max-w-read text-2xs text-subtle">
                    <span class="text-content">{{ verdict.state === `due` ? `Shown because` : `Shows when` }}:</span> {{ verdict.chore.criterion }}
                </p>

                <!-- The evidence, verbatim from the measurement. One claim per line and never summarised further:
                 this is the list the reader checks the rule above against. -->
                <ul v-if="verdict.detail.length > 0" class="mt-3 flex flex-col gap-1">
                    <li v-for="line in verdict.detail" :key="line" class="font-mono text-2xs text-content">{{ line }}</li>
                </ul>

                <p v-if="evidenceNote" class="mt-3 max-w-read text-2xs text-subtle">{{ evidenceNote }}</p>

                <!-- The last run, whatever it concluded. A `clean` outcome is shown as prominently as any other: it is
                 the agent saying the findings did not hold up, and that is a result, not a non-event. -->
                <div v-if="run" class="mt-3 flex flex-wrap items-center gap-2 text-2xs text-subtle">
                    <span>{{ run.running ? `running` : (run.result?.outcome ?? `no result written`) }} · {{ timeAgo(run.manifest.createdAt) }}</span>
                    <button type="button" class="cursor-pointer underline hover:text-content" @click="emit(`open`, run.manifest.conversationId)">
                        open the transcript
                    </button>
                </div>
                <p v-if="run?.result?.summary" class="mt-1 max-w-read text-xs text-content">{{ run.result.summary }}</p>

                <div class="mt-4 flex flex-wrap items-center gap-2">
                    <!-- No "start an agent" on a clear or unmeasured chore: a button that spends money proving nothing
                     is wrong is an invitation this surface should not be making. -->
                    <AgentRunButton
                        v-if="verdict.prompt !== undefined && verdict.state !== `clear`"
                        :label="verdict.chore.stance === `act` ? `Fix it` : `Look into it`"
                        icon="play"
                        :model-label="runModel.model.value.label"
                        :effort-label="runModel.model.value.effortLabel"
                        :overridden="runModel.overridden.value"
                        :disabled="busy || busyHere || liveAgent !== undefined"
                        @run="startRun"
                        @pick="runModel.choose"
                    />
                    <!-- The one move a stale row has, and the reason it has no "Fix it" beside it: nobody can decide
                     whether there is work here until something has looked at the tree since the last turn.
                     It stays on the row WHILE it runs, wearing the state, rather than vanishing: a control that
                     disappears when pressed leaves nowhere to look for what pressing it did, and the button is
                     where the reader's eye already is. -->
                    <Button
                        v-if="verdict.state === `stale` || busyHere"
                        size="small"
                        severity="secondary"
                        :label="busyHere ? `Measuring…` : `Re-measure`"
                        :title="
                            busyHere
                                ? `Measuring ${measuringWhat}: a deep check can take a few minutes`
                                : `Measure this again now, a deep check can take a few minutes`
                        "
                        :disabled="busy || busyHere"
                        @click="emit(`remeasure`)"
                    >
                        <!-- The kit's icon set, through the slot: the underlying Button's own `icon` prop takes a
                         PrimeIcons class name, so passing a name from our set renders an empty box. -->
                        <template #icon><Icon :name="busyHere ? `spinner` : `refresh`" :spin="busyHere" /></template>
                    </Button>
                    <Button v-if="liveAgent" size="small" severity="secondary" text label="Watch it" @click="emit(`open`, liveAgent)" />
                    <Button
                        v-if="verdict.state === `due`"
                        size="small"
                        severity="secondary"
                        text
                        label="Not now"
                        title="Keep it listed, keep it out of the rail, for a month"
                        @click="emit(`snooze`)"
                    />
                    <Button v-if="verdict.state === `snoozed`" size="small" severity="secondary" text label="Un-snooze" @click="emit(`unsnooze`)" />
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
