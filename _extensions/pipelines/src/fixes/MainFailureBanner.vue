<script setup lang="ts">
import type { FixResume, MainFailureHandBack, PipelineRun } from "@intentic/sandbox-contract";
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
    toneInk,
    toneTint,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, onUpdated, ref } from "vue";
import { host } from "../host";
import { handBackOf, jobsAtAGlance, type MainFailureStory, type MainFailureView, offersFix, storyOf } from "./mainFailures";
import { t } from "../i18n.js";

// A FAILING MAIN LINE AS ONE INCIDENT: a header that says what broke and what happens next, and under it, joined to it by
// a drawn lane, the very runs it speaks for (coveredRuns), so a reader sees which rows the fix is about instead of
// inferring it from a strip above a list in time order. It is also the ONE place the fix is pressed: the rows inside
// offer none (leadsRows), since every press on main goes to the same agent anyway.
//
// The header is two lines. The first: the branch, since when and which jobs, and on the right who has it (a pill that
// opens the agent) and the one press. The second: one sentence (storyOf) on where the fix stands and the reader's move,
// read off the agent's live stance, so "Fix landed" comes with "commit and push it" rather than an agent "on it". Never
// the daemon's sentence, never a turn's error: those live in the fix agent's conversation, one click away.

const props = defineProps<{
    view: MainFailureView;
    // The runs drawn inside this block (coveredRuns), the view's rows in the default slot; read here for the sentence.
    covered: readonly PipelineRun[];
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
const jobsLine = computed(() => {
    const { shown, folded } = jobs.value;
    return [shown.join(`, `), ...(folded.length > 0 ? [t(`mainFailure.moreJobs`, { count: folded.length })] : [])].join(` `);
});

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
    waiting: () => t(`mainFailure.story.waiting`),
    ended: () => t(`mainFailure.story.ended`),
    waits: () => t(`mainFailure.story.waits`, { reason: handBack.value }),
    reported: () => t(`mainFailure.story.reported`),
    unassigned: () => t(`mainFailure.story.unassigned`),
} as const satisfies Readonly<Record<MainFailureStory, () => string>>;
const story = computed(() => STORY[storyOf(props.view, props.covered)]());

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
    <!-- One faint danger wash over the header and the runs inside: the block reads as one incident, not as one more row. -->
    <section
        ref="root"
        :data-main-failure="`${failure.repo}:${failure.branch}`"
        :data-state="view.state"
        :aria-label="t(`mainFailure.title`, { branch: failure.branch })"
        :class="toneTint(`danger`, `soft`, `relative`)"
    >
        <div class="flex flex-col gap-1 py-3 pr-3 pl-4">
            <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                <!-- What fails, since when, and which jobs. `flex-auto`, not `flex-1`: sized by its words, so a narrow pane wraps
                     the pill and press onto their own line instead of squeezing the branch name to nothing under them. -->
                <div class="flex min-w-0 flex-auto items-center gap-2">
                    <Icon data-lane-head name="exclamation-circle" class="shrink-0 text-base text-danger" />
                    <span class="shrink-0 text-base font-semibold text-content">{{ t(`mainFailure.title`, { branch: failure.branch }) }}</span>
                    <span class="min-w-0 truncate text-xs text-subtle">
                        <span v-tooltip.top="formatTimestamp(failure.since)">{{ t(`mainFailure.since`, { when: since }) }}</span>
                        <template v-if="jobs.shown.length > 0">
                            · <span :aria-label="t(`mainFailure.failingJobs`)" v-tooltip.top="failure.jobs.join(`, `)">{{ jobsLine }}</span>
                        </template>
                    </span>
                </div>

                <!-- Who has it, and the one press. -->
                <div class="ml-auto flex shrink-0 items-center gap-2">
                    <component
                        :is="pill.link ? `a` : `span`"
                        v-if="pill !== undefined"
                        v-bind="pill.link ? fixerLink : {}"
                        data-fixer
                        class="ui-chip inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium"
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
            <p data-story class="pl-6 text-sm text-muted">{{ story }}</p>
        </div>

        <!-- The runs this incident speaks for, indented off the lane; hairlines between them start where they do, so none
             crosses the lane. -->
        <div v-if="covered.length > 0" class="ml-8 divide-y divide-line-subtle">
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
