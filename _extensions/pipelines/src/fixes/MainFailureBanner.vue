<script setup lang="ts">
import type { MainFailureHandBack, PipelineRun } from "@intentic/sandbox-contract";
import { activeLocale, appLink, Button, fixStanceLook, formatDate, formatDayMonthTime, formatTimestamp, Icon } from "@intentic/extension-ui";
import { computed } from "vue";
import { host } from "../host";
import { handBackOf, jobsAtAGlance, type MainFailureView, offersFix } from "./mainFailures";
import { t } from "../i18n.js";

// A FAILING MAIN LINE, said once at the head of its repository's runs, above the rows that say it run by run. Two lines:
// what fails (the branch, since when, which jobs), and on the same line as the branch the one thing a reader wants next
// — who has it, and what they can press. The daemon put one fix agent on it at the first failed job and sends it every
// later failure on the branch until a run passes; while it works the banner names it by its live stance and asks
// nothing. Once the daemon hands the failure back (its turns spent, it stopped, or repairs are off) the banner says so in
// two words and offers the press that gives it back. Never the daemon's sentence, never a turn's error: those live in
// the fix agent's conversation, one click away.

const props = defineProps<{
    view: MainFailureView;
    // The action the view has in flight, by run key; the press here shares the run rows' lock.
    busy: string | undefined;
}>();
const emit = defineEmits<{ fix: [run: PipelineRun] }>();

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

// The one press the banner offers (offersFix), on the newest failed run it names. Nothing to press while the agent
// works, or when the board no longer lists that run. Continue when there is an agent to give its turns back to.
const press = computed<{ label: string; primary: boolean } | undefined>(() => {
    if (!offersFix(props.view)) {
        return undefined;
    }
    if (props.view.state === `waits` && fixerId.value !== undefined) {
        return { label: t(`mainFailure.continueFix`), primary: true };
    }
    // Before the sandbox has decided, the press is a way to start sooner, not a demand.
    return { label: t(`mainFailure.fixWithAgent`), primary: props.view.state !== `unassigned` };
});
const runKey = computed(() => (props.view.run === undefined ? undefined : `${props.view.run.host}:${props.view.run.project}:${props.view.run.runId}`));
const pressFix = (): void => {
    if (props.view.run !== undefined) {
        emit(`fix`, props.view.run);
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
    <!-- The run rows' own left stripe, in the one tone a failing branch wears; the faint wash says this line speaks for all of them. -->
    <section
        :data-main-failure="`${failure.repo}:${failure.branch}`"
        :data-state="view.state"
        :aria-label="t(`mainFailure.title`, { branch: failure.branch })"
        class="flex flex-col gap-1.5 border-l-4 border-l-danger bg-danger/5 py-2.5 pr-3 pl-4"
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

            <!-- Who has it, and the one press, where the run rows below keep theirs. -->
            <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                <!-- Working: the agent's live stance as the run rows draw it; the chip is the way in. -->
                <a
                    v-if="view.state === `fixing` && fixerLink !== undefined"
                    v-bind="fixerLink"
                    data-fixer
                    class="ui-chip shrink-0 rounded px-2 py-1 text-xs font-medium"
                    :class="look === undefined ? [`text-info`, `border-info/30 hover:bg-info/10`] : [look.ink, look.chip]"
                    v-tooltip.top="{
                        title: t(`mainFailure.takesEveryFailure`),
                        rows: [
                            { label: t(`tip.branch`), value: failure.branch },
                            { label: t(`tip.model`), value: view.fixer?.model ?? `` },
                        ],
                        note: t(`mainFailure.untilARunPasses`),
                    }"
                >
                    <Icon :name="look?.icon ?? `robot`" :spin="look?.spin ?? false" class="text-2xs" />
                    {{ view.stance?.label ?? t(`mainFailure.fixAgent`) }}
                </a>
                <span v-else-if="view.state === `fixing`" data-fixer class="text-xs text-subtle">{{ t(`mainFailure.fixAgent`) }}</span>

                <!-- Handed back: two words on why, the way into what it tried, and the press that gives it its turns back. -->
                <template v-else-if="view.state === `waits`">
                    <span
                        data-waits
                        class="inline-flex items-center gap-1.5 text-xs"
                        v-tooltip.top="{ title: t(`mainFailure.handedBack`), tone: `warn`, note: t(`mainFailure.continueGivesTurns`) }"
                    >
                        <Icon name="exclamation-triangle" class="text-2xs text-warning" />
                        <span class="font-medium text-warning">{{ t(`mainFailure.needsYou`) }}</span>
                        <span class="text-muted">· {{ handBack }}</span>
                    </span>
                    <a v-if="fixerLink !== undefined" v-bind="fixerLink" class="touch-target text-xs font-medium text-link hover:underline">{{
                        t(`mainFailure.openFixer`)
                    }}</a>
                </template>

                <span
                    v-else-if="view.state === `reported`"
                    data-waits
                    class="inline-flex items-center gap-1.5 text-xs"
                    v-tooltip.top="{ title: t(`mainFailure.noAgentSent`), tone: `warn` }"
                >
                    <Icon name="exclamation-triangle" class="text-2xs text-warning" />
                    <span class="font-medium text-warning">{{ t(`mainFailure.needsYou`) }}</span>
                    <span class="text-muted">· {{ t(`mainFailure.repairsOff`) }}</span>
                </span>

                <span v-else-if="view.state === `unassigned`" class="text-xs text-subtle">{{ t(`mainFailure.unassigned`) }}</span>

                <Button
                    v-if="press !== undefined"
                    :label="press.label"
                    size="small"
                    :severity="press.primary ? undefined : `secondary`"
                    :text="!press.primary"
                    :loading="busy !== undefined && busy === runKey"
                    :disabled="busy !== undefined"
                    @click="pressFix"
                />
            </div>
        </div>

        <!-- Which jobs, a few by name: the run row below draws every one of them in its graph. -->
        <ul v-if="jobs.shown.length > 0" class="flex min-w-0 flex-wrap items-center gap-1 pl-6" :aria-label="t(`mainFailure.failingJobs`)">
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
    </section>
</template>
