<script setup lang="ts">
import type { FixResume } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import type { CiRepo, MainFailureHandBack, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import {
    type AgentRunAttempt,
    AgentRunButton,
    type AgentRunChoice,
    appLink,
    fixStanceLook,
    formatClock,
    formatDate,
    formatDayMonthTime,
    formatTimestamp,
    Icon,
    toneDot,
    toneFill,
    toneInk,
    tonePlate,
    toneRim,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, onUpdated, ref } from "vue";
import { host } from "../host";
import { failingWorkflowsOf, handBackOf, jobsAtAGlance, type MainFailureStory, type MainFailureView, offersFix, storyOf } from "./mainFailures";
import { t } from "../i18n.js";

// A FAILING MAIN LINE AS ONE INCIDENT: a header that says what broke and what happens next, and under it, joined to it by
// a drawn lane, the very runs it speaks for (coveredRuns), so a reader sees which rows the fix is about instead of
// inferring it from a strip above a list in time order. It is also the ONE place the fix is pressed: the rows inside
// offer none (leadsRows), since every press on main goes to the same agent anyway.
//
// It is a card of its own above the repository's run list (RowGroup's `lead`), not the list's first row: a rim, a bar
// down its edge, a square plate where rows have round status glyphs, and a filled header. Drawn as a row it read as one
// more run, and on a board of green rows that is how "main is failing" got lost.
//
// The header says three things. What fails: the branch and since when, then each failing workflow by name with its jobs
// and a link to its failing run (failingWorkflowsOf), since a nightly that fails while every CI run passes is otherwise a
// banner over a board with nothing red on it. Who has it: a pill that opens the agent, and the one press. And one
// sentence (storyOf) on where the fix stands and the reader's move, read off the agent's live stance, so "Fix landed"
// comes with "commit and push it" rather than an agent "on it". Never the daemon's sentence, never a turn's error: those
// live in the fix agent's conversation, one click away.

const props = defineProps<{
    view: MainFailureView;
    // The runs drawn inside this block (coveredRuns), the view's rows in the default slot; read here for the sentence.
    covered: readonly PipelineRun[];
    // Every run the board lists for the repository, and the repository itself: a failing workflow's run is linked from
    // the board's row when it has one, else from the forge's own address for it.
    runs: readonly PipelineRun[];
    repo: CiRepo | undefined;
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
const jobs = computed(() => jobsAtAGlance(failure.value.jobs));
const jobsLineOf = (names: readonly string[]): string => {
    const { shown, folded } = jobsAtAGlance(names);
    return [shown.join(`, `), ...(folded.length > 0 ? [t(`mainFailure.moreJobs`, { count: folded.length })] : [])].join(` `);
};
const jobsLine = computed(() => jobsLineOf(failure.value.jobs));
// Each workflow failing, by name, with its jobs and its run. Empty from a daemon that does not say, which leaves the
// flat job list.
const workflows = computed(() => failingWorkflowsOf(failure.value, props.runs, props.repo));
const workflowNames = computed(() => workflows.value.filter((workflow) => workflow.named).map((workflow) => workflow.name));

// The fixer's newest attempt when the fleet has it, else the conversation the failure names, which the chat can still
// open from the archive.
const fixerId = computed(() => props.view.fixer?.id ?? failure.value.fixer ?? failure.value.decision?.conversationId);
const fixerLink = computed(() => {
    const id = fixerId.value;
    return id === undefined ? undefined : appLink(api.href(`/agents/${id}`), () => api.chat.openAgent(id));
});

// Why it was handed back, in two words the sentence leads with. Undefined reads "Handed back": an older daemon recorded
// no reason, only a sentence that could run to a paragraph.
const HAND_BACK = {
    turns: () => t(`mainFailure.handBackTurns`),
    "no-change": () => t(`mainFailure.handBackNoChange`),
    stopped: () => t(`mainFailure.handBackStopped`),
    interrupted: () => t(`mainFailure.handBackInterrupted`),
    "turn-failed": () => t(`mainFailure.handBackTurnFailed`),
    gone: () => t(`mainFailure.handBackGone`),
    refused: () => t(`mainFailure.handBackRefused`),
} as const satisfies Readonly<Record<MainFailureHandBack, () => string>>;
const handBack = computed(() => {
    const reason = handBackOf(props.view);
    return reason === undefined ? t(`mainFailure.handedBack`) : HAND_BACK[reason]();
});

// Where the fix stands and the reader's move, as one sentence a newcomer reads without a tooltip.
const STORY = {
    working: () => t(`mainFailure.story.working`, { branch: failure.value.branch }),
    needsYou: () => t(`mainFailure.story.needsYou`),
    ready: () => t(`mainFailure.story.ready`),
    landed: () => t(`mainFailure.story.landed`, { branch: failure.value.branch }),
    proving: () => t(`mainFailure.story.proving`, { branch: failure.value.branch }),
    pushed: () =>
        workflowNames.value.length === 0
            ? t(`mainFailure.story.pushedUnnamed`, { branch: failure.value.branch })
            : t(
                  `mainFailure.story.pushed`,
                  { branch: failure.value.branch, workflows: workflowNames.value.join(`, `), count: workflowNames.value.length },
                  workflowNames.value.length,
              ),
    waiting: () => t(`mainFailure.story.waiting`),
    ended: () => t(`mainFailure.story.ended`),
    waits: () => t(`mainFailure.story.waits`, { reason: handBack.value }),
    reported: () => t(`mainFailure.story.reported`),
    unassigned: () => t(`mainFailure.story.unassigned`),
} as const satisfies Readonly<Record<MainFailureStory, () => string>>;
const story = computed(() => STORY[storyOf(props.view, props.covered, props.runs)]());

// Who has it, as one pill: the agent's live stance while it works (the run rows' own look), "Needs you" once it is
// handed back, and the way into the agent whenever there is one. Undefined before anybody is on it.
const pill = computed<(ReturnType<typeof fixStanceLook> & { label: string; link: boolean }) | undefined>(() => {
    const view = props.view;
    if (view.state === `fixing`) {
        const look = fixStanceLook(view.stance?.kind ?? `working`);
        return { label: view.stance?.label ?? t(`mainFailure.fixAgent`), ...look, link: fixerLink.value !== undefined };
    }
    if (view.state === `waits` || view.state === `reported`) {
        const look = fixStanceLook(`ended`);
        const label = view.state === `waits` ? t(`mainFailure.needsYou`) : t(`mainFailure.repairsOff`);
        return { label, ...look, link: view.state === `waits` && fixerLink.value !== undefined };
    }
    return undefined;
});

// The one press the block offers (offersFix), on the newest failed run it names. Nothing to press while the agent
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
// run row's did before the block took the press over. Continuable: the daemon gives that agent its turns back.
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

// The wall-clock minute it started failing, with its day once it is not today's: "10:20", "Sep 24, 09:10".
const since = computed(() =>
    formatDate(failure.value.since) === formatDate(Date.now()) ? formatClock(failure.value.since) : formatDayMonthTime(failure.value.since),
);

// THE LANE: a trunk down from the header's glyph and an elbow into each covered row's status glyph (`data-lane-node`,
// PipelineRunRow), drawn from where they actually sit rather than from row heights this block cannot know: a row
// opens into its job graph, a narrow pane wraps its title. Re-measured whenever the block changes size or re-renders,
// once per frame.
const ELBOW = 6;
const GAP = 4;
const root = ref<HTMLElement>();
const lane = ref<{ width: number; height: number; d: string } | undefined>();

const draw = (): void => {
    const el = root.value;
    const head = el?.querySelector(`[data-lane-head]`);
    if (el === undefined || head === null || head === undefined) {
        lane.value = undefined;
        return;
    }
    const box = el.getBoundingClientRect();
    const top = head.getBoundingClientRect();
    const x = top.left + top.width / 2 - box.left;
    const nodes = [...el.querySelectorAll(`[data-lane-node]`)].map((node) => {
        const at = node.getBoundingClientRect();
        return { y: at.top + at.height / 2 - box.top, end: at.left - box.left - GAP };
    });
    const last = nodes.at(-1);
    if (last === undefined) {
        lane.value = undefined;
        return;
    }
    const trunk = `M ${x} ${top.bottom - box.top + GAP} V ${last.y - ELBOW}`;
    const elbows = nodes.map(({ y, end }) => `M ${x} ${y - ELBOW} Q ${x} ${y} ${x + ELBOW} ${y} H ${end}`);
    lane.value = { width: box.width, height: box.height, d: [trunk, ...elbows].join(` `) };
};

let frame = 0;
const measure = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
};
let observer: ResizeObserver | undefined;
onMounted(() => {
    measure();
    if (root.value !== undefined) {
        observer = new ResizeObserver(measure);
        observer.observe(root.value);
    }
});
onUpdated(measure);
onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
});
</script>

<template>
    <!-- A card of its own above the run list: rim, a bar down its edge and a filled header, so it reads as the branch's
         alarm rather than one more run. The covered runs below its header keep the card's plain fill. -->
    <section
        ref="root"
        :data-main-failure="`${failure.repo}:${failure.branch}`"
        :data-state="view.state"
        :aria-label="t(`mainFailure.title`, { branch: failure.branch })"
        :class="toneRim(`danger`, `strong`, `relative overflow-hidden rounded-xl border bg-card shadow-sm`)"
    >
        <span aria-hidden="true" :class="toneDot(`danger`, `absolute inset-y-0 left-0 w-1`)" />

        <div :class="toneFill(`danger`, `strong`, `flex flex-col gap-2 py-3.5 pr-3 pl-4`)">
            <div class="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2">
                <!-- What fails, since when, and in which workflows. `flex-auto`, not `flex-1`: sized by its words, so a narrow
                     pane wraps the pill and press onto their own line instead of squeezing the branch name to nothing. -->
                <div class="flex min-w-0 flex-auto items-start gap-3">
                    <!-- A square plate where every run row has a round glyph: the lane starts here. -->
                    <span data-lane-head :class="tonePlate(`danger`, `flex size-8 shrink-0 items-center justify-center rounded-lg`)">
                        <Icon name="exclamation-circle" class="text-sm" />
                    </span>
                    <div class="flex min-w-0 flex-col gap-0.5">
                        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                            <span class="text-base font-semibold text-content">{{ t(`mainFailure.title`, { branch: failure.branch }) }}</span>
                            <span class="text-xs text-subtle" v-tooltip.top="formatTimestamp(failure.since)">{{
                                t(`mainFailure.since`, { when: since })
                            }}</span>
                        </div>

                        <!-- Each workflow failing, linked to its failing run: the one place the reader learns a nightly fails
                             while every push passes, and the way to its run when the list below does not hold it. -->
                        <div
                            v-if="workflows.length > 0"
                            data-workflows
                            class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                            :aria-label="t(`mainFailure.failingJobs`)"
                        >
                            <a
                                v-for="workflow in workflows"
                                :key="workflow.name"
                                :href="workflow.url"
                                target="_blank"
                                rel="noopener"
                                class="group inline-flex min-w-0 items-center gap-1.5 hover:text-link"
                                v-tooltip.top="{
                                    title: t(`mainFailure.openRun`),
                                    tone: `danger`,
                                    rows: [
                                        { label: t(`tip.run`), value: `#${workflow.runId}` },
                                        { label: t(`mainFailure.failingJobs`), value: workflow.jobs.join(`, `) },
                                    ],
                                    note: workflow.listed ? undefined : t(`mainFailure.runNotListed`),
                                }"
                            >
                                <span v-if="workflow.named" class="shrink-0 font-semibold text-content group-hover:text-link">{{ workflow.name }}</span>
                                <span class="min-w-0 truncate font-mono text-muted group-hover:text-link">{{ jobsLineOf(workflow.jobs) }}</span>
                                <Icon name="external-link" class="shrink-0 text-2xs text-subtle group-hover:text-link" />
                            </a>
                        </div>
                        <span
                            v-else-if="jobs.shown.length > 0"
                            class="min-w-0 truncate font-mono text-xs text-muted"
                            :aria-label="t(`mainFailure.failingJobs`)"
                            v-tooltip.top="failure.jobs.join(`, `)"
                            >{{ jobsLine }}</span
                        >
                    </div>
                </div>

                <!-- Who has it, and the one press. -->
                <div class="ml-auto flex shrink-0 items-center gap-2">
                    <component
                        :is="pill.link ? `a` : `span`"
                        v-if="pill !== undefined"
                        v-bind="pill.link ? fixerLink : {}"
                        data-fixer
                        class="ui-chip inline-flex shrink-0 items-center gap-1.5 rounded bg-card px-2 py-1 text-xs font-medium"
                        :class="[pill.ink, pill.link ? pill.chip : `border-line`]"
                        v-tooltip.top="
                            pill.link
                                ? { title: t(`mainFailure.openFixer`), rows: [{ label: t(`tip.model`), value: view.fixer?.model ?? `` }] }
                                : undefined
                        "
                    >
                        <Icon :name="pill.icon" :spin="pill.spin" class="text-2xs" />
                        {{ pill.label }}
                    </component>

                    <!-- The run rows' own split button, moved up with the press: the caret re-points the model, and over an
                         agent that already tried, its panel ends in Continue / Start over. -->
                    <AgentRunButton
                        v-if="press !== undefined"
                        :label="starting !== undefined && starting === runKey ? t(`pipelineRunRow.readingLogs`) : press.label"
                        :picker="picker"
                        :tier="press.primary ? `accent` : `quiet`"
                        :loading="busy !== undefined && busy === runKey"
                        :disabled="busy !== undefined"
                        @run="pressFix"
                    />
                </div>
            </div>

            <!-- Where the fix stands and the reader's move, aligned under the title. -->
            <p data-story class="pl-11 text-sm text-content">{{ story }}</p>
        </div>

        <!-- The runs this incident speaks for, indented off the lane; hairlines between them start where they do, so none
             crosses the lane. -->
        <div v-if="covered.length > 0" :class="toneRim(`danger`, `soft`, `ml-10 divide-y divide-line-subtle border-t`)">
            <slot />
        </div>

        <svg
            v-if="lane !== undefined"
            :class="toneInk(`danger`, `pointer-events-none absolute inset-0 opacity-50`)"
            :width="lane.width"
            :height="lane.height"
            :viewBox="`0 0 ${lane.width} ${lane.height}`"
            fill="none"
            aria-hidden="true"
        >
            <path :d="lane.d" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
    </section>
</template>
