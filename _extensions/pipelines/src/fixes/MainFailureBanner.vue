<script setup lang="ts">
import type { FixResume, MainFailureHandBack, PipelineRun } from "@intentic/sandbox-contract";
import {
    activeLocale,
    AgentRunButton,
    type AgentRunAttempt,
    type AgentRunChoice,
    appLink,
    fixStanceLook,
    formatDate,
    formatDayMonthTime,
    formatTimestamp,
    Icon,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { computed } from "vue";
import { host } from "../host";
import { handBackOf, jobsAtAGlance, type MainFailureState, type MainFailureView, offersFix } from "./mainFailures";
import { t } from "../i18n.js";

// A FAILING MAIN LINE, said once at the head of its repository's runs, and the ONE place its fix is pressed: the run rows
// under it offer none (mainFailures.ts, leadsRows), since every press on main goes to the same agent anyway. Three lines:
// what fails and who has it (the branch, since when, and on the right the agent's live stance or the one press), one
// plain sentence on what auto-fix did and what happens next, which is what tells a reader this is not another run row,
// and which jobs fail now. The daemon put one fix agent on it at the first failed job and sends it every later failure on
// the branch until a run passes; while it works the banner names it by its live stance and asks nothing. Once the daemon
// hands it back (its turns spent, it stopped, or repairs are off) the banner says so and offers the press that gives it
// back. Never the daemon's sentence, never a turn's error: those live in the fix agent's conversation, one click away.

const props = defineProps<{
    view: MainFailureView;
    // The action the view has in flight, by run key; the press here shares the run rows' lock.
    busy: string | undefined;
    // The run whose fix press is out, by run key: the press then names its wait, as the run row's does.
    starting?: string | undefined;
}>();
// The run row's own event, so the view handles both the same way: the caret's model pick, and the verb its panel ended
// with over the agent's attempt (Continue / Start over).
const emit = defineEmits<{ fix: [run: PipelineRun, pick: AgentRunChoice | undefined, resume: FixResume | undefined] }>();

const api = host();

const failure = computed(() => props.view.failure);
const look = computed(() => (props.view.stance === undefined ? undefined : fixStanceLook(props.view.stance.kind)));
const jobs = computed(() => jobsAtAGlance(failure.value.jobs));

// The fixer's newest attempt when the fleet has it, else the conversation the failure names, which the chat can still
// open from the archive.
const fixerId = computed(() => props.view.fixer?.id ?? failure.value.fixer ?? failure.value.decision?.conversationId);
const fixerLink = computed(() => {
    const id = fixerId.value;
    return id === undefined ? undefined : appLink(api.href(`/agents/${id}`), () => api.chat.openAgent(id));
});

// Why it was handed back, in the banner's own two words. Undefined reads "Handed back": an older daemon recorded no
// reason, only a sentence that could run to a paragraph.
const HAND_BACK: Readonly<Record<MainFailureHandBack, () => string>> = {
    turns: () => t(`mainFailure.handBackTurns`),
    "no-change": () => t(`mainFailure.handBackNoChange`),
    stopped: () => t(`mainFailure.handBackStopped`),
    interrupted: () => t(`mainFailure.handBackInterrupted`),
    "turn-failed": () => t(`mainFailure.handBackTurnFailed`),
    gone: () => t(`mainFailure.handBackGone`),
    refused: () => t(`mainFailure.handBackRefused`),
};
const handBack = computed(() => {
    const reason = handBackOf(props.view);
    return reason === undefined ? t(`mainFailure.handedBack`) : HAND_BACK[reason]();
});

// What auto-fix did about it and what happens next, in one sentence a newcomer can read without a tooltip: the line that
// says this strip speaks for the branch, not for one run.
const STORY = {
    fixing: () => t(`mainFailure.story.fixing`, { branch: failure.value.branch }),
    waits: () => t(`mainFailure.story.waits`),
    reported: () => t(`mainFailure.story.reported`),
    unassigned: () => t(`mainFailure.story.unassigned`),
} as const satisfies Readonly<Record<MainFailureState, () => string>>;
const story = computed(() => STORY[props.view.state]());

// The one press the banner offers (offersFix), on the newest failed run it names. Nothing to press while the agent
// works, or when the board no longer lists that run. Continue when there is an agent to give its turns back to.
const continues = computed(() => props.view.state === `waits` && fixerId.value !== undefined);
const press = computed<{ label: string; primary: boolean } | undefined>(() => {
    if (!offersFix(props.view)) {
        return undefined;
    }
    if (continues.value) {
        return { label: t(`mainFailure.continueFix`), primary: true };
    }
    // Before the sandbox has decided, the press is a way to start sooner, not a demand.
    return { label: t(`mainFailure.fixWithAgent`), primary: props.view.state !== `unassigned` };
});

// The agent the caret's panel is about when the press continues one, so its bar ends in Continue / Start over, as the
// run row's did before the banner took the press over. Continuable: the daemon gives that agent its turns back.
const attemptOnOffer = computed<AgentRunAttempt | undefined>(() => {
    const fixer = props.view.fixer;
    if (!continues.value || fixer === undefined) {
        return undefined;
    }
    const files = fixer.diff?.files ?? 0;
    const summary = [
        t(`mainFailure.autoFixAgent`),
        fixer.model,
        props.view.stance?.label.toLowerCase(),
        files === 0 ? undefined : t(`mainFailure.filesOnBranch`, { count: files }, files),
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
    return { summary, continuable: true };
});
const picker = useAgentRunPick(
    () => api.models,
    `pipeline-fix`,
    () => attemptOnOffer.value,
);

const runKey = computed(() =>
    props.view.run === undefined ? undefined : `${props.view.run.host}:${props.view.run.project}:${props.view.run.runId}`,
);
const pressFix = (): void => {
    if (props.view.run !== undefined) {
        emit(`fix`, props.view.run, picker.overridden.value ? picker.model.value : undefined, picker.resume.value);
        picker.clear();
    }
};

// The wall-clock minute it started failing, with its day once it is not today's: "10:20", "Sep 24, 09:10". The house
// clock is 24-hour in every language (format.ts), so the hour is pinned rather than left to the locale.
const clockOf = (at: number): string => new Intl.DateTimeFormat(activeLocale.value, { hour: `2-digit`, minute: `2-digit`, hour12: false }).format(at);
const since = computed(() =>
    formatDate(failure.value.since) === formatDate(Date.now()) ? clockOf(failure.value.since) : formatDayMonthTime(failure.value.since),
);
</script>

<template>
    <!-- The faint danger wash, no edge stripe, says this line speaks for all the runs under it; its glyph sits on the rows' own left edge. -->
    <section
        :data-main-failure="`${failure.repo}:${failure.branch}`"
        :data-state="view.state"
        :aria-label="t(`mainFailure.title`, { branch: failure.branch })"
        class="flex flex-col gap-1 bg-danger/5 py-2.5 pr-3 pl-4"
    >
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <!-- What fails, and since when. `flex-auto`, not `flex-1`: sized by its words, so a narrow pane wraps the press
                 cluster onto its own line instead of squeezing the branch name to nothing under it. -->
            <div class="flex min-w-0 flex-auto items-center gap-2">
                <Icon name="exclamation-circle" class="shrink-0 text-sm text-danger" />
                <span class="truncate text-sm font-semibold text-content">{{ t(`mainFailure.title`, { branch: failure.branch }) }}</span>
                <span class="shrink-0 text-2xs text-subtle" v-tooltip.top="formatTimestamp(failure.since)">{{
                    t(`mainFailure.since`, { when: since })
                }}</span>
            </div>

            <!-- Who has it, and the one press, where the run rows below keep their Re-run. -->
            <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                <!-- Working: the agent's live stance as the run rows draw it; the chip is the way in. -->
                <a
                    v-if="view.state === `fixing` && fixerLink !== undefined"
                    v-bind="fixerLink"
                    data-fixer
                    class="ui-chip shrink-0 rounded px-2 py-1 text-xs font-medium"
                    :class="look === undefined ? [`text-info`, `border-info/30 hover:bg-info/10`] : [look.ink, look.chip]"
                    v-tooltip.top="{ title: t(`mainFailure.openFixer`), rows: [{ label: t(`tip.model`), value: view.fixer?.model ?? `` }] }"
                >
                    <Icon :name="look?.icon ?? `robot`" :spin="look?.spin ?? false" class="text-2xs" />
                    {{ view.stance?.label ?? t(`mainFailure.fixAgent`) }}
                </a>
                <span v-else-if="view.state === `fixing`" data-fixer class="text-xs text-subtle">{{ t(`mainFailure.fixAgent`) }}</span>

                <!-- Handed back: two words on why, and the way into what it tried; the story line says what Continue does. -->
                <template v-else-if="view.state === `waits`">
                    <span data-waits class="inline-flex items-center gap-1.5 text-xs">
                        <Icon name="exclamation-triangle" class="text-2xs text-warning" />
                        <span class="font-medium text-warning">{{ t(`mainFailure.needsYou`) }}</span>
                        <span class="text-muted">· {{ handBack }}</span>
                    </span>
                    <a v-if="fixerLink !== undefined" v-bind="fixerLink" class="touch-target text-xs font-medium text-link hover:underline">{{
                        t(`mainFailure.openFixer`)
                    }}</a>
                </template>

                <span v-else-if="view.state === `reported`" data-waits class="inline-flex items-center gap-1.5 text-xs">
                    <Icon name="exclamation-triangle" class="text-2xs text-warning" />
                    <span class="font-medium text-warning">{{ t(`mainFailure.needsYou`) }}</span>
                    <span class="text-muted">· {{ t(`mainFailure.repairsOff`) }}</span>
                </span>

                <span v-else-if="view.state === `unassigned`" class="text-xs text-subtle">{{ t(`mainFailure.unassigned`) }}</span>

                <!-- The run row's own split button, moved up with the press: the caret re-points the model, and over an
                     agent that already tried, its panel ends in Continue / Start over. -->
                <AgentRunButton
                    v-if="press !== undefined"
                    :label="starting !== undefined && starting === runKey ? t(`pipelineRunRow.readingLogs`) : press.label"
                    :picker="picker"
                    :severity="press.primary ? undefined : `secondary`"
                    :text="!press.primary"
                    :loading="busy !== undefined && busy === runKey"
                    :disabled="busy !== undefined"
                    @run="pressFix"
                />
            </div>
        </div>

        <!-- What auto-fix did and what comes next, in words: why this strip exists, and why the rows under it have no Fix. -->
        <p data-story class="pl-6 text-xs text-muted">{{ story }}</p>

        <!-- Which jobs, a few by name: the run row below draws every one of them in its graph. -->
        <div v-if="jobs.shown.length > 0" class="flex min-w-0 flex-wrap items-center gap-1 pl-6">
            <span class="mr-1 text-2xs text-subtle">{{ t(`mainFailure.failingNow`) }}</span>
            <ul class="flex min-w-0 flex-wrap items-center gap-1" :aria-label="t(`mainFailure.failingJobs`)">
                <li
                    v-for="job in jobs.shown"
                    :key="job"
                    class="inline-flex max-w-64 items-center rounded border border-line bg-canvas px-1.5 py-px font-mono text-2xs text-muted"
                >
                    <span class="truncate" v-tooltip.top.overflow="job">{{ job }}</span>
                </li>
                <li v-if="jobs.folded.length > 0" class="px-1 text-2xs text-subtle" v-tooltip.top="jobs.folded.join(`, `)">
                    {{ t(`mainFailure.moreJobs`, { count: jobs.folded.length }) }}
                </li>
            </ul>
        </div>
    </section>
</template>
