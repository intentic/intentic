<script setup lang="ts">
import { choreAnswer, choreAnswered, type ChoreVerdict, probeSpec, repoName } from "@intentic/sandbox-contract/chores";
import {
    AgentRunButton,
    type AgentRunChoice,
    Button,
    DisclosureRow,
    freshness,
    Icon,
    type IconName,
    StatusBadge,
    type StatusVariant,
    timeAgo,
    ui,
    useAgentRunPick,
    useNow,
} from "@intentic/extension-ui";
import { host } from "./host";
import { computed, ref, watch } from "vue";
import { summarySpans } from "./runs";
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
const { verdict, run, measuring, expanded } = defineProps<{
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
const runModel = useAgentRunPick(() => host().models, `maintenance-chore`);
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

// What is actually being run, by the probe's own name for its subject: "measuring" is a spinner, "measuring how
// much of the tree is duplicated" is a fact, and the difference is whether the reader can tell a stuck row from
// a slow one.
const measuringWhat = computed(() => inFlight.value.map((entry) => probeSpec(entry.id).measures).join(` and `));

/* THE RE-MEASURE, ON EVERY ROW THAT RESTS ON A MEASUREMENT. It used to appear only on `stale` rows, and asking
 * for a fresh measurement anywhere else meant finding the right one of seven refresh buttons in a strip above
 * the list, which required knowing which tool decides this chore. The row knows: `needs` is the chore's own
 * list of probes, and pressing this re-runs all of them. Chores with no probes (the surveys, documentation)
 * have nothing to re-measure and get no button.
 *
 * The subject is named, and the cost is told BEFORE the press rather than after the sandbox goes quiet: a tier-2
 * probe genuinely runs for minutes, and a tier-1 one is seconds, so the warning is attached to the chores that
 * have earned it instead of being said on every row until it is ignored. */
const measures = computed(() => verdict.chore.needs.map((id) => probeSpec(id).measures).join(` and `));
const deep = computed(() => verdict.chore.needs.some((id) => probeSpec(id).tier === 2));
// "Re-measure" is a lie on a chore that has never been measured, which is exactly the row (`unavailable`) where
// pressing it is most worth doing: a probe that failed, or a tool that has since been installed.
const measureLabel = computed(() => (verdict.measuredAt === undefined ? `Measure now` : `Re-measure`));
const measureTitle = computed(() =>
    busyHere.value
        ? `Measuring ${measuringWhat.value}${deep.value ? `: a deep check can take a few minutes` : ``}`
        : `Measure ${measures.value} again now${deep.value ? `, a deep check can take a few minutes` : ``}`,
);

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

const liveAgent = computed(() => (run?.running === true ? run.manifest.conversationId : undefined));

/* WHETHER ANYONE HAS ALREADY ANSWERED THIS ROW, on the row, where it is read. A chore is a question, a turn is
 * somebody answering it, and the collapsed row used to carry only the question: an advisory an agent had reported
 * back on ten minutes earlier was drawn exactly like one nobody had ever opened, so the only way to find out that
 * the work had been done was to open every row and read to the bottom of the drawer.
 *
 * `choreAnswer` (verdict.ts) is the shared decision, digest-checked, so this mark and the demotion the list does
 * around it are one fact rather than two that can drift.
 *
 * Not while a turn is live. `liveAgent` and the spinner already say a turn is HAPPENING, and "reported 5m ago"
 * beside them would be the previous answer competing with the one being written.
 *
 * And not on a CLEAR row, where the headline is already the answer in words — "Checked, the findings did not hold
 * up", "Surveyed 12 days ago" — so the mark would say the same thing a second time, in a smaller font, next to
 * the age it just quoted. The mark exists to tell a live finding that has been answered from one that has not;
 * a row with nothing to act on is not asking that question. */
const answer = computed(() => (liveAgent.value === undefined && verdict.state !== `clear` ? choreAnswer(verdict) : undefined));

/* Whether there is anything left to start here, which is what the tint below turns on and what the list sorts
 * on. A lapsed chore is not one of these: it still shows what was concluded last time and still asks at full
 * weight, because the cadence lapsing is the book asking again.
 *
 * Read from the verdict rather than from `answer` above, so starting a second turn does not undo the first. If
 * this hung off the suppressed mark, pressing the button on an answered row would flip its badge back to amber
 * for the length of the turn: a row visibly getting WORSE the moment you act on it, saying a thing that is not
 * true. A turn being under way does not unmake the one that already ran. */
const standing = computed(() => choreAnswered(verdict));

/* Three words with three meanings, and the mark is two of them wide, so the sentence lives in the tooltip. The
 * distinction that matters most is `reported` against `acted`: one of them left a branch to read and the other
 * left a decision to make, and a reader who takes "reported" for "fixed" has been misled by this row. */
const ANSWER_MEANS: Record<string, string> = {
    acted: `changed something`,
    reported: `changed nothing and handed back what it found`,
    clean: `looked, and the findings did not hold up`,
};
const answerTitle = computed<string>(() => {
    const at = answer.value;
    if (at === undefined) {
        return ``;
    }
    const said = `A turn ran against exactly this evidence ${timeAgo(at.ranAt, { days: true })} and ${ANSWER_MEANS[at.outcome] ?? at.outcome}.`;
    // A lapsed answer is the one case where the row keeps asking despite having been answered, and saying so is
    // the difference between a reader trusting the two marks and thinking they contradict each other.
    return standing.value ? `${said} Open the row to read it.` : `${said} It is being asked again on this chore's own cadence.`;
});

/* The state, as one badge. `unavailable` is deliberately NOT a warning colour: nothing is wrong, we simply have
 * not measured it, and painting that amber would make every repo without knip look broken. `stale` is quiet for
 * the same reason and one more: it is the state a row lands in BECAUSE the work got done, and a colour that reads
 * as a problem would make finishing a chore look like breaking something.
 *
 * AND NEITHER IS AN ANSWERED `due` ROW, which is the same argument one step further on. Amber is this page's only
 * alarm and it is worth exactly what it is spent on: a risk nobody has looked at yet. A `security-advisories` row
 * has `cadenceMs: 0`, so once a turn has reported on it and the evidence has been re-measured it is `due` and
 * `settled` FOREVER — and it wore full amber the whole time, next to a heading counting it as this morning's
 * work, for a decision the owner had already made. The word stays (`carrying` is still true, and the row is still
 * in the CARRYING group with all of its evidence); the shout comes off, because it was answered. */
const status = computed<{ variant: StatusVariant; label: string } | undefined>(() => {
    // Measuring outranks every settled state, because it is the only one that is about to stop being true, and
    // a row that reads "stale" while it is being re-measured is the exact complaint this all started as.
    if (busyHere.value) {
        return { variant: `info`, label: `measuring` };
    }
    if (verdict.state === `due`) {
        if (standing.value) {
            return { variant: `neutral`, label: verdict.severity === `warning` ? `carrying` : `due` };
        }
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
 * would ever look, which is why this is now the only place it is said. A strip above the list used to repeat it
 * per probe, and that is a line of chips nobody's eye is on when it reads "279 unreferenced files". */
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

/* THE EVIDENCE, SPLIT WHERE IT WAS ALREADY BROKEN. Every chore writes its lines as `<tag> · <claim>` —
 * `high · image-size, ICNS parser…`, `major · vite 6.3.5 → 8.2.1`, `unreferenced · src/legacyPlans.ts` — and
 * the panel drew the whole string as one mono run at the row's full width. On a wide pane that is a
 * 140-character line of 11px monospace per advisory, which is the least readable configuration this app has:
 * the tag that classifies the line is buried in it, and the eye has no column to run down.
 *
 * A grid gives the tags one column as wide as the widest of them, so they align without a magic width, and the
 * claims wrap in a column capped at the reading measure instead of at the pane's. Lines with no separator keep
 * the whole width — several chores write a bare sentence, and inventing a tag for those would be a lie. */
const detailRows = computed(() =>
    verdict.detail.map((line) => {
        const at = line.indexOf(` · `);
        return at === -1 ? { key: line, tag: undefined, claim: line } : { key: line, tag: line.slice(0, at), claim: line.slice(at + 3) };
    }),
);
/* Eight, because that is the cap the chores that DO cap themselves already chose (DETAIL_LIMIT): a capped chore
 * therefore never folds, and only the genuinely unbounded lists — every major behind, every advisory — do.
 * The fold states the total, so nothing is hidden, it is just not spent before you have asked for it. */
const EVIDENCE_SHOWN = 8;
const allEvidence = ref(false);
const shownDetail = computed(() => (allEvidence.value ? detailRows.value : detailRows.value.slice(0, EVIDENCE_SHOWN)));

/* THE AGENT'S REPORT, WHICH IS THE PART THAT RUNS AWAY. `summary` is asked for as "one or two sentences" and
 * arrives as whatever the turn felt like writing — the run that prompted this rewrite filed nine sentences of
 * dense prose, set at the same size and colour as everything else in the drawer, directly above the buttons,
 * which it pushed off the screen. It is genuinely useful and it is NOT the thing you opened the row to read:
 * the evidence is why the row exists and the verbs are what you came to press. So it keeps its place and loses
 * its dominance — three lines on its own surface, the rest one press away, and its backticked literals drawn as
 * code (summarySpans, in runs.ts beside the parser that reads the field). */
const summaryParts = computed(() => summarySpans(run?.result?.summary ?? ``));
// Roughly three lines at the reading measure: below it the clamp has nothing to hide and a "Show more" that
// reveals nothing is worse than no control at all.
const SUMMARY_CLAMPED = 220;
const wholeSummary = ref(false);
const summaryLong = computed(() => (run?.result?.summary ?? ``).length > SUMMARY_CLAMPED);

/* What the last run concluded, as a badge rather than as a bare lowercase word in a grey line. `clean` is a
 * success and says so: the agent looked and the findings did not hold up, which is a result. */
const runTone = computed<{ variant: StatusVariant; label: string }>(() => {
    if (run?.running === true) {
        return { variant: `info`, label: `running` };
    }
    const outcome = run?.result?.outcome;
    if (outcome === undefined) {
        return { variant: `neutral`, label: `no result written` };
    }
    return { variant: outcome === `reported` ? `info` : `success`, label: outcome };
});

// Both folds belong to one reading of one row: leaving them open means the next row you open starts halfway
// through a sentence you never asked to see.
watch(
    () => expanded,
    (open) => {
        if (!open) {
            allEvidence.value = false;
            wholeSummary.value = false;
        }
    },
);
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
            <!-- THE ANSWER, LEFT OF THE STATE. Reading order is the argument: the state badge is the row's
                 conclusion and belongs at the end of the line, so what qualifies it has to come before it —
                 "reported 5m ago, carrying" is a sentence, "carrying, reported 5m ago" is a correction.

                 OUTLINED WHERE THE STATE BADGE IS FILLED, which is the whole reason this is not a second
                 <StatusBadge>. On an answered row the state badge is neutral, so two neutral pills would be two
                 identical grey lozenges and the reader would have to read both to find out which was which. A
                 hairline mark against a filled one is a rank the eye resolves before it reads either.

                 The age drops on a narrow pane and the word never does: `reported` alone is still the answer,
                 where a bare "5m ago" is a fact about nothing. The exact sentence is in the tooltip either way. -->
            <span
                v-if="answer"
                :title="answerTitle"
                class="flex shrink-0 items-center gap-1 rounded-full border border-line/60 px-1.5 py-0.5 text-2xs text-subtle"
            >
                <Icon name="check-circle" class="text-2xs" />
                <!-- The lowercasing is the badge convention and it belongs to the WORD, not to the chip: run it
                     over the whole mark and `freshness` past a day comes out as "sep 2, 2026", a date drawn in a
                     way no other date in the app is. -->
                <span class="lowercase">{{ answer.outcome }}</span>
                <span class="@lg:inline hidden text-subtle/70">{{ freshness(answer.ranAt) }}</span>
            </span>
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

                <!-- THE EVIDENCE LEADS, which is the whole reordering. This drawer used to open on two paragraphs
                 of preamble — what the chore is, then the rule that makes it due — before a single fact, on a row
                 whose title and headline the reader had just read in order to press it. Four prose blocks at three
                 sizes, none labelled, all flush left at one indent: a wall, and the numbers were in the middle of
                 it. The facts are first now, and everything that qualifies them follows.

                 Verbatim from the measurement, never summarised further: this is the list the rule below is
                 checked against. -->
                <ul v-if="shownDetail.length > 0" class="grid max-w-read grid-cols-facts items-baseline gap-x-3 gap-y-1">
                    <li v-for="row in shownDetail" :key="row.key" class="contents">
                        <span class="font-mono text-2xs text-subtle">{{ row.tag }}</span>
                        <span class="min-w-0 break-words font-mono text-2xs text-content">{{ row.claim }}</span>
                    </li>
                </ul>
                <button
                    v-if="detailRows.length > EVIDENCE_SHOWN"
                    type="button"
                    :class="ui.linkButton(`mt-1.5 text-2xs text-subtle hover:text-content`)"
                    @click="allEvidence = !allEvidence"
                >
                    {{ allEvidence ? `Show fewer` : `Show all ${detailRows.length}` }}
                </button>

                <!-- WHAT THE CHORE IS AND WHAT MAKES IT DUE, one muted block under the evidence rather than two
                 ahead of it. The rule is still said in full, and it is still said as what WOULD make this due so
                 it reads the same whether the chore is due or clear: a row that says "3 advisories" and nothing
                 else asks to be taken on trust, where a row that names its threshold can be argued with, and
                 arguing with it is how the book gets better. What changed is that it is now the FOOTNOTE to the
                 evidence it qualifies, which is where a reader goes looking for it, instead of the toll paid
                 before reaching a number. -->
                <p class="mt-3 max-w-read text-2xs leading-relaxed text-subtle">
                    {{ verdict.chore.description }}
                    <span class="text-content">{{ verdict.state === `due` ? `Shown because` : `Shows when` }}:</span> {{ verdict.chore.criterion }}
                </p>

                <!-- THE LAST RUN, ON A SURFACE OF ITS OWN. It is a different voice from everything above it — an
                 agent's report, not a measurement — and drawn as bare prose at the drawer's own size it simply
                 continued the wall, with the buttons somewhere below the fold. The tint is the same device this
                 drawer already uses for the measuring and landed strips, so the reader can take it in or skip it
                 as one object. A `clean` outcome wears the same badge as any other: it is the agent saying the
                 findings did not hold up, which is a result, not a non-event. -->
                <div v-if="run" class="mt-3 flex max-w-read flex-col gap-1.5 rounded-lg bg-content/5 px-3 py-2">
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
                        <StatusBadge :variant="runTone.variant" :label="runTone.label" size="xs" />
                        <span>{{ timeAgo(run.manifest.createdAt) }}</span>
                        <button type="button" class="cursor-pointer underline hover:text-content" @click="emit(`open`, run.manifest.conversationId)">
                            open the transcript
                        </button>
                    </div>
                    <p v-if="run.result?.summary" class="text-xs leading-relaxed text-content" :class="wholeSummary ? undefined : `line-clamp-3`">
                        <template v-for="(part, index) in summaryParts" :key="index"
                            ><code v-if="part.code" class="rounded bg-content/10 px-1 font-mono text-2xs">{{ part.text }}</code
                            ><template v-else>{{ part.text }}</template></template
                        >
                    </p>
                    <button
                        v-if="summaryLong"
                        type="button"
                        :class="ui.linkButton(`w-fit text-2xs text-subtle hover:text-content`)"
                        @click="wholeSummary = !wholeSummary"
                    >
                        {{ wholeSummary ? `Show less` : `Show more` }}
                    </button>
                </div>

                <p v-if="evidenceNote" class="mt-3 max-w-read text-2xs leading-relaxed text-subtle">{{ evidenceNote }}</p>

                <!-- The verbs, under a rule. Everything above them is now bounded — eight evidence rows, three
                 lines of report — so this is a place on the drawer rather than wherever the prose happened to
                 end. -->
                <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
                    <!-- No "start an agent" on a clear or unmeasured chore: a button that spends money proving nothing
                     is wrong is an invitation this surface should not be making.

                     AND IT SAYS "AGAIN" WHEN IT WOULD BE AGAIN. A row whose answer still stands kept offering
                     "Fix it" in the same words as a row nobody had opened, which reads as the first attempt and
                     is the second: the press is still available, because a second turn at a better tier is a
                     legitimate thing to want, but the button should not be the one telling you the work has not
                     been done. -->
                    <AgentRunButton
                        v-if="verdict.prompt !== undefined && verdict.state !== `clear`"
                        :label="standing ? `Run it again` : verdict.chore.stance === `act` ? `Fix it` : `Look into it`"
                        icon="play"
                        :model-label="runModel.model.value.label"
                        :effort-label="runModel.model.value.effortLabel"
                        :overridden="runModel.overridden.value"
                        :disabled="busy || busyHere || liveAgent !== undefined"
                        @run="startRun"
                        @pick="runModel.choose"
                    />
                    <!-- The only way this page asks for a measurement, and the one move a stale row has: nobody
                     can decide whether there is work here until something has looked at the tree since the last
                     turn, which is why a stale row has this and no "Fix it".
                     It stays on the row WHILE it runs, wearing the state, rather than vanishing: a control that
                     disappears when pressed leaves nowhere to look for what pressing it did, and the button is
                     where the reader's eye already is. -->
                    <Button
                        v-if="verdict.chore.needs.length > 0"
                        size="small"
                        severity="secondary"
                        :label="busyHere ? `Measuring…` : measureLabel"
                        :title="measureTitle"
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
