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

// One chore in one repository: the row answers what it is, whether it's due, and whether anyone has looked; opened, it
// shows the evidence. Every claim expands into the specific packages, files or advisories behind it, including a clear
// chore's own measurement.

// Boolean, not a repo string: the row knows its repo; the list knows whether more than one is shown.
// Whole sandbox's list, not pre-filtered: the row filters to its own repo and probes itself.
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

// Per-row model choice, seeded via the host so the button and daemon agree on cost.
const runModel = useAgentRunPick(() => host().models, `maintenance-chore`);
const startRun = (): void => {
    emit(`start`, runModel.overridden.value ? runModel.model.value : undefined);
    runModel.clear();
};

// Measuring while any of the chore's `needs` probes is; evidence only replaces once all have landed.
const inFlight = computed(() => measuring.filter((entry) => entry.repo === verdict.repo && verdict.chore.needs.includes(entry.id)));
const busyHere = computed(() => inFlight.value.length > 0);

// Wall clock, armed only while this row has something running.
const now = useNow(busyHere);

// Time since start; the runner has one lane sandbox-wide, so a queued probe may not have started yet.
const elapsed = computed<string>(() => {
    const started = inFlight.value.map((entry) => entry.startedAt).filter((at) => at !== undefined);
    if (started.length === 0) {
        return `waiting for the machine`;
    }
    const seconds = Math.max(0, Math.round((now.value - Math.min(...started)) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
});

// Named by the probe's own subject, not generic 'measuring': lets a reader tell stuck from slow.
const measuringWhat = computed(() => inFlight.value.map((entry) => probeSpec(entry.id).measures).join(` and `));

// Shown on every chore with `needs`; pressing re-runs all its probes. The warning names the subject and cost (tier-2
// runs minutes, tier-1 seconds) before the press.
const measures = computed(() => verdict.chore.needs.map((id) => probeSpec(id).measures).join(` and `));
const deep = computed(() => verdict.chore.needs.some((id) => probeSpec(id).tier === 2));
// 'Re-measure' is wrong on an unmeasured chore; label switches to 'Measure now' there.
const measureLabel = computed(() => (verdict.measuredAt === undefined ? `Measure now` : `Re-measure`));
const measureTitle = computed(() =>
    busyHere.value
        ? `Measuring ${measuringWhat.value}${deep.value ? `: a deep check can take a few minutes` : ``}`
        : `Measure ${measures.value} again now${deep.value ? `, a deep check can take a few minutes` : ``}`,
);

// Keeps the headline visible from before a measurement starts, then reports what changed (including 'nothing'); cleared
// on collapse, not persisted.
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

// Undefined while a turn is live, or on a clear row whose headline already states the answer.
const answer = computed(() => (liveAgent.value === undefined && verdict.state !== `clear` ? choreAnswer(verdict) : undefined));

// Read from the verdict, not `answer`: starting a second turn must not undo the first's standing.
const standing = computed(() => choreAnswered(verdict));

// `reported` left something to read; `acted` left something to decide — do not conflate them.
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
    // A lapsed row keeps asking despite being answered; say so, or the two marks look contradictory.
    return standing.value ? `${said} Open the row to read it.` : `${said} It is being asked again on this chore's own cadence.`;
});

// Neutral, not warning, for `unavailable`/`stale` (nothing is wrong, or the work is done) and for an answered `due`
// row: amber means only an unlooked-at risk.
const status = computed<{ variant: StatusVariant; label: string } | undefined>(() => {
    // Measuring outranks every other state: it is the one about to stop being true.
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

// Shown on every measured state, not just stale: an old count and a fresh one are different claims.
const measured = computed<string | undefined>(() => (verdict.measuredAt === undefined ? undefined : `measured ${timeAgo(verdict.measuredAt)}`));

// States what the last run means for this evidence: stale says nothing has measured since the last turn; settled says
// it was re-measured and unchanged.
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

// Splits each `<tag> · <claim>` line into a tag column and a wrapping claim column; a line with no `·` keeps the full
// width.
const detailRows = computed(() =>
    verdict.detail.map((line) => {
        const at = line.indexOf(` · `);
        return at === -1 ? { key: line, tag: undefined, claim: line } : { key: line, tag: line.slice(0, at), claim: line.slice(at + 3) };
    }),
);
// Matches DETAIL_LIMIT, the cap chores already self-impose; only genuinely unbounded lists fold.
const EVIDENCE_SHOWN = 8;
const allEvidence = ref(false);
const shownDetail = computed(() => (allEvidence.value ? detailRows.value : detailRows.value.slice(0, EVIDENCE_SHOWN)));

// Turn summaries can run long and dense; clamped to three lines with the rest a press away. Backticked literals render
// as code via `summarySpans` (runs.ts).
const summaryParts = computed(() => summarySpans(run?.result?.summary ?? ``));
// Roughly three lines at the reading measure; below that, 'Show more' would reveal nothing.
const SUMMARY_CLAMPED = 220;
const wholeSummary = ref(false);
const summaryLong = computed(() => (run?.result?.summary ?? ``).length > SUMMARY_CLAMPED);

// Last run's outcome as a badge, not a bare word; `clean` reads as success: the findings did not hold up.
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

// Resets both folds on collapse, so the next row opened does not inherit them.
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
    <!--
        `@container`: fitting title and headline on one line depends on pane width, not viewport. `body="drawer"` gives the opened row its own place,
        not a hanging fact.
    -->
    <DisclosureRow
        class="@container border-t border-line/60 first:border-t-0"
        density="compact"
        body="drawer"
        :open="expanded"
        @update:open="emit(`toggle`)"
    >
        <template #lead="{ iconClass }">
            <Icon :name="verdict.chore.icon as IconName" class="shrink-0 text-muted" :class="iconClass" />
        </template>

        <!--
            Wide pane: title keeps full width, headline takes the flexible column. Narrow pane: both stack and truncate on their own line so the
            state badge stays legible.
        -->
        <template #title>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5 font-normal @lg:flex-row @lg:items-center @lg:gap-3">
                <span class="@lg:shrink-0 flex min-w-0 items-center gap-2">
                    <span class="min-w-0 truncate text-content">{{ verdict.chore.title }}</span>
                    <span v-if="showRepo" class="shrink-0 rounded bg-content/5 px-1.5 py-0.5 text-2xs text-subtle">
                        {{ repoName(verdict.repo) }}
                    </span>
                </span>
                <!-- Age never truncates, headline always does: a clipped count reads fine, a clipped age does not. -->
                <span class="flex min-w-0 flex-1 items-baseline gap-2">
                    <span class="min-w-0 truncate text-xs text-subtle">{{ verdict.headline }}</span>
                    <span v-if="measured" class="shrink-0 text-2xs text-subtle/70">{{ measured }}</span>
                </span>
            </span>
        </template>

        <!-- One spinner covers either kind of in-flight work; two side by side would say nothing extra. -->
        <template #meta>
            <Icon v-if="liveAgent || busyHere" name="spinner" spin class="shrink-0 text-subtle" />
            <!--
                Sits left of the state badge for reading order ('reported 5m ago, carrying'), outlined so it doesn't read as a second neutral pill.
                The age hides on a narrow pane; the word never does.
            -->
            <span
                v-if="answer"
                :title="answerTitle"
                class="ui-status-pill flex shrink-0 items-center gap-1 border border-line/60 text-2xs text-subtle"
            >
                <Icon name="check-circle" class="text-2xs" />
                <!-- Lowercases only the outcome word, not the whole mark, or a `freshness` date lowercases too. -->
                <span class="lowercase">{{ answer.outcome }}</span>
                <span class="@lg:inline hidden text-subtle/70">{{ freshness(answer.ranAt) }}</span>
            </span>
            <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" class="shrink-0" />
        </template>

        <template #below>
            <div class="@lg:px-2">
                <!--
                    At the top of the opened row, above the evidence it is replacing: the first thing to read after pressing the button. States the
                    subject and that the numbers below are still the old ones.
                -->
                <div v-if="busyHere" class="mb-3 flex items-start gap-2 rounded-lg bg-info/10 px-3 py-2">
                    <Icon name="spinner" spin class="mt-0.5 shrink-0 text-xs text-info" />
                    <!-- Always two lines: appending the caveat inline wrapped badly on narrower panes. -->
                    <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="flex flex-wrap items-baseline gap-x-2">
                            <span class="text-xs text-content">Measuring {{ measuringWhat }}…</span>
                            <span class="text-2xs text-subtle">{{ elapsed }}</span>
                        </span>
                        <span class="text-2xs text-subtle/70">The figures below are the ones being replaced.</span>
                    </span>
                </div>

                <!--
                    Held until the row collapses, not faded on a timer, so a reader who looks away still finds it. 'Unchanged' is stated as loudly as
                    a change: it is a finding too.
                -->
                <div v-else-if="landed" class="mb-3 flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2">
                    <Icon name="check-circle" class="mt-0.5 shrink-0 text-xs text-success" />
                    <!-- Same two-line shape as the strip above. Before/after stays one wrapping unit, or the arrow ends up alone on its own line. -->
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

                <!--
                    Evidence comes first; everything that qualifies it follows. Verbatim from the measurement: this is the list the rule below is
                    checked against.
                -->
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

                <!--
                    Footnote to the evidence above, not a preamble ahead of it. Phrased as what WOULD make this due, so it reads the same whether the
                    chore is due or clear.
                -->
                <p class="mt-3 max-w-read text-2xs leading-relaxed text-subtle">
                    {{ verdict.chore.description }}
                    <span class="text-content">{{ verdict.state === `due` ? `Shown because` : `Shows when` }}:</span> {{ verdict.chore.criterion }}
                </p>

                <!--
                    Own tinted block, the same device as the measuring/landed strips above, not bare prose. `clean` wears the same badge as any
                    outcome: it is a result, not a non-event.
                -->
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

                <!-- Verbs sit under a rule at a fixed place: everything above them is now bounded (eight evidence rows, three report lines). -->
                <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
                    <!--
                        Hidden on a clear or unmeasured chore: spending money to prove nothing wrong is not this surface's job. Labelled 'Run it
                        again' only once the answer already stands; the press itself stays available for a second attempt at a better tier.
                    -->
                    <AgentRunButton
                        v-if="verdict.prompt !== undefined && verdict.state !== `clear`"
                        :label="standing ? `Run it again` : verdict.chore.stance === `act` ? `Fix it` : `Look into it`"
                        icon="play"
                        :picker="runModel"
                        :disabled="busy || busyHere || liveAgent !== undefined"
                        @run="startRun"
                    />
                    <!--
                        The only measurement trigger on the page, and the one move a stale row has. Stays visible and wears the running state instead
                        of vanishing on press.
                    -->
                    <Button
                        v-if="verdict.chore.needs.length > 0"
                        size="small"
                        severity="secondary"
                        :label="busyHere ? `Measuring…` : measureLabel"
                        :title="measureTitle"
                        :disabled="busy || busyHere"
                        @click="emit(`remeasure`)"
                    >
                        <!-- Via slot, not the `icon` prop: that prop expects a PrimeIcons class name, not this icon set. -->
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
