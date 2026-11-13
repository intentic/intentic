<script setup lang="ts">
import type { FixResume } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import type { CiRepo, CiRunParam, MainFailureHandBack, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import {
    type AgentRunAttempt,
    type AgentRunBooking,
    AgentRunButton,
    type AgentRunChoice,
    appLink,
    Button,
    ConfirmDialog,
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
    ui,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, onUpdated, ref } from "vue";
import { host } from "../host";
import {
    dispatchKey,
    type FailingWorkflow,
    failingSince,
    failingWorkflowsOf,
    forgetKey,
    handBackOf,
    jobsAtAGlance,
    type MainFailureStory,
    type MainFailureView,
    offersFix,
    stalls,
    storyOf,
} from "./mainFailures";
import { t } from "../i18n.js";

// One incident card above the run list connects coveredRuns and owns the only fix action; nested run rows suppress duplicate actions.
// Show branch/since, every failing workflow/jobs/run link, the fix agent and its live storyOf next step (including commit/push after land).
// Each workflow line also says what blocks it (blockerOf) with the press that clears it: the cancelled run's own row to
// re-run, Run now for a scheduled one, Stop tracking one nothing measures; the whole failure can be marked resolved
// behind a confirm.
// Use a distinct filled card/header so main's failure cannot read as another run; raw daemon/turn errors stay in the agent conversation.

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
}>();
// The run row's own event, so the view handles both the same way: the caret's model pick, and the verb its panel ended
// with over the agent's attempt (Continue / Start over).
// `dispatch` starts a workflow afresh on the branch, `forget` takes one workflow (or, with none, the whole failure) off
// it: the view runs each and keys `busy` the way this block reads it (mainFailures.ts). A cancelled run's Re-run is its
// own row's, drawn inside this block (coveredRuns), so the line only points at it rather than offering a second.
const emit = defineEmits<{
    fix: [run: PipelineRun, pick: AgentRunChoice | undefined, resume: FixResume | undefined, booking: AgentRunBooking | undefined];
    dispatch: [run: CiRunParam];
    forget: [workflow: string | undefined];
}>();

const api = host();

const failure = computed(() => props.view.failure);
const jobs = computed(() => jobsAtAGlance(failure.value.jobs));
// A job that ran out of time says so: the forge calls it cancelled, and the reader would otherwise look for a test.
const jobsLineOf = (names: readonly string[], timedOut: readonly string[] = []): string => {
    const { shown, folded } = jobsAtAGlance(names);
    const spelled = shown.map((name) => (timedOut.includes(name) ? t(`mainFailure.timedOutJob`, { job: name }) : name));
    return [spelled.join(`, `), ...(folded.length > 0 ? [t(`mainFailure.moreJobs`, { count: folded.length })] : [])].join(` `);
};
const jobsLine = computed(() => jobsLineOf(failure.value.jobs));
// Each workflow failing, by name, with its jobs and its run. Empty from a daemon that does not say, which leaves the
// flat job list.
const workflows = computed(() => failingWorkflowsOf(failure.value, props.runs, props.repo));
// The workflows nothing on its way will measure, which the stalled sentence names.
const stalledNames = computed(() => workflows.value.filter((workflow) => workflow.named && stalls(workflow.blocker)).map((workflow) => workflow.name));

// The fixer's newest attempt when the fleet has it, else the conversation the failure names, which the chat can still
// open from the archive.
const fixerId = computed(() => props.view.fixer?.id ?? failure.value.fixer ?? failure.value.decision?.conversationId);
const fixerLink = computed(() => {
    const id = fixerId.value;
    return id === undefined ? undefined : appLink(api.href(api.links.agent(id)), () => api.chat.openAgent(id));
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
    collecting: () => t(`mainFailure.story.collecting`),
    "failed-again": () => t(`mainFailure.story.failedAgain`, { branch: failure.value.branch }),
    stalled: () =>
        stalledNames.value.length === 0
            ? t(`mainFailure.story.stalledUnnamed`)
            : t(`mainFailure.story.stalled`, { workflows: stalledNames.value.join(`, `), count: stalledNames.value.length }, stalledNames.value.length),
    waiting: () => t(`mainFailure.story.waiting`),
    ended: () => t(`mainFailure.story.ended`),
    waits: () => t(`mainFailure.story.waits`, { reason: handBack.value }),
    reported: () => t(`mainFailure.story.reported`),
    unassigned: () => t(`mainFailure.story.unassigned`),
    outside: () => t(`mainFailure.story.outside`, { step: props.view.ownerStep ?? `` }),
} as const satisfies Readonly<Record<MainFailureStory, () => string>>;
const story = computed(() => STORY[storyOf(props.view, props.covered, props.runs)]());

// The attempt count rides in the pill once there has been more than one: a failure on its tenth attempt is stuck in a way
// no single attempt's stance says.
const attempts = computed(() => {
    const count = failure.value.attempts ?? 0;
    return count > 1 ? t(`mainFailure.attempt`, { count }) : undefined;
});
// Who has it, as one pill: the agent's live stance while it works (the run rows' own look), "Needs you" once it is
// handed back, and the way into the agent whenever there is one. Undefined before anybody is on it.
const pill = computed<(ReturnType<typeof fixStanceLook> & { label: string; link: boolean }) | undefined>(() => {
    const view = props.view;
    if (view.state === `failed-again`) {
        return { ...fixStanceLook(`ended`), label: t(`mainFailure.newFailures`), link: fixerLink.value !== undefined };
    }
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
    if (props.view.state === `failed-again`) {
        return { label: t(`mainFailure.fixNow`), primary: true };
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
        emit(`fix`, props.view.run, picker.overridden.value ? picker.model.value : undefined, picker.resume.value, picker.booking.value);
        picker.clear();
    }
};

// The wall-clock minute it started failing, with its day once it is not today's: "10:20", "Sep 24, 09:10". The
// longest-failing workflow's own start, not when the failure first opened (failingSince).
const sinceAt = computed(() => failingSince(failure.value));
const when = (at: number): string => (formatDate(at) === formatDate(Date.now()) ? formatClock(at) : formatDayMonthTime(at));
const since = computed(() => when(sinceAt.value));
// A workflow's own start, spelled only where the block names more than one: with one, it is the header's.
const ownSince = (workflow: FailingWorkflow): string | undefined =>
    workflow.since === undefined || workflows.value.length < 2 ? undefined : t(`mainFailure.since`, { when: when(workflow.since) });

// What blocks each workflow, in a few words, and the press that clears it (blockerOf). A workflow whose newest run is
// the failing one says nothing here: the story's sentence is its next step.
interface BlockerLine {
    readonly text: string;
    readonly actions: readonly { readonly label: string; readonly key: string; readonly press: () => void }[];
}
const sha7 = (run: PipelineRun): string => run.sha.slice(0, 7);
const dispatchOf = (workflow: FailingWorkflow) => {
    const param = { repo: failure.value.repo, runId: workflow.runId };
    return { label: t(`mainFailure.runNow`), key: dispatchKey(param), press: () => emit(`dispatch`, param) };
};
const forgetOf = (workflow: FailingWorkflow) => ({
    label: t(`mainFailure.stopTracking`),
    key: forgetKey(failure.value, workflow.name),
    press: () => emit(`forget`, workflow.name),
});
const blockerLine = (workflow: FailingWorkflow): BlockerLine | undefined => {
    const blocker = workflow.blocker;
    switch (blocker.kind) {
        case `measuring`:
            return { text: t(`mainFailure.blocker.measuring`, { sha: sha7(blocker.run) }), actions: [] };
        case `cancelled`:
            return { text: t(`mainFailure.blocker.cancelled`, { sha: sha7(blocker.run) }), actions: [] };
        case `scheduled`:
            return { text: t(`mainFailure.blocker.scheduled`), actions: [dispatchOf(workflow)] };
        case `quiet`:
            return {
                text: t(`mainFailure.blocker.quiet`, { when: formatDayMonthTime(blocker.failedAt), drop: formatDayMonthTime(blocker.dropsAt) }),
                actions: [...(blocker.scheduled ? [dispatchOf(workflow)] : []), forgetOf(workflow)],
            };
        default:
            return undefined;
    }
};
const lines = computed(() => new Map(workflows.value.map((workflow) => [workflow.name, blockerLine(workflow)])));

// Marking the whole failure resolved ends it for every workflow at once, so it asks first; one workflow's Stop tracking
// does not, since a later failure of it opens it again.
const resolving = ref(false);
const resolveKey = computed(() => forgetKey(failure.value, undefined));
const resolve = (): void => {
    resolving.value = false;
    emit(`forget`, undefined);
};

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
    const d = [trunk, ...elbows].join(` `);
    // Written only when it moved. A write re-renders this block, and every render asks for a frame to measure in
    // (onUpdated), so a lane written afresh each time was measured and drawn again every frame for as long as the block
    // was mounted: the pipelines view's steady stream of long frames.
    const drawn = lane.value;
    if (drawn?.d !== d || drawn.width !== box.width || drawn.height !== box.height) {
        lane.value = { width: box.width, height: box.height, d };
    }
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
                            <span class="text-xs text-subtle" v-tooltip.top="formatTimestamp(sinceAt)">{{ t(`mainFailure.since`, { when: since }) }}</span>
                        </div>

                        <!-- Each workflow failing, linked to its failing run: the one place the reader learns a nightly fails
                             while every push passes, and the way to its run when the list below does not hold it. Beside it,
                             what blocks it from passing and the press that clears it (blockerOf), so a failure nothing will
                             measure on its own says so where it is read. -->
                        <ul
                            v-if="workflows.length > 0"
                            data-workflows
                            class="flex min-w-0 flex-col gap-1 text-xs"
                            :aria-label="t(`mainFailure.failingJobs`)"
                        >
                            <li
                                v-for="workflow in workflows"
                                :key="workflow.name"
                                :data-workflow="workflow.name"
                                :data-blocker="workflow.blocker.kind"
                                class="group/row flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
                            >
                                <a
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
                                    <span class="min-w-0 truncate font-mono text-muted group-hover:text-link">{{
                                        jobsLineOf(workflow.jobs, workflow.timedOut)
                                    }}</span>
                                    <Icon name="external-link" class="shrink-0 text-2xs text-subtle group-hover:text-link" />
                                </a>
                                <span v-if="ownSince(workflow) !== undefined" class="shrink-0 text-subtle">{{ ownSince(workflow) }}</span>
                                <template v-if="lines.get(workflow.name) !== undefined">
                                    <span data-blocker-text class="min-w-0 text-content">{{ lines.get(workflow.name)?.text }}</span>
                                    <Button
                                        v-for="action in lines.get(workflow.name)?.actions ?? []"
                                        :key="action.key"
                                        :label="action.label"
                                        size="small"
                                        tier="boring"
                                        :loading="busy === action.key"
                                        :disabled="busy !== undefined"
                                        @click="action.press"
                                    />
                                </template>
                                <!-- Any workflow can be let go of by hand; one whose line already offers it as its way forward
                                     carries no second press. Quiet, and shown on the line's hover where a pointer can. -->
                                <button
                                    v-if="workflow.blocker.kind !== `quiet`"
                                    type="button"
                                    data-stop-tracking
                                    :class="ui.iconButton({ size: `sm` }, `shrink-0 md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100`)"
                                    :aria-label="t(`mainFailure.stopTrackingNamed`, { workflow: workflow.name })"
                                    :disabled="busy !== undefined"
                                    v-tooltip.top="t(`mainFailure.stopTracking`)"
                                    @click="forgetOf(workflow).press()"
                                >
                                    <Icon name="eye-slash" class="text-2xs" />
                                </button>
                            </li>
                        </ul>
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
                        class="ui-chip inline-flex shrink-0 items-center bg-card font-medium"
                        :class="[pill.ink, pill.link ? pill.chip : `border-line`]"
                        v-tooltip.top="
                            pill.link
                                ? { title: t(`mainFailure.openFixer`), rows: [{ label: t(`tip.model`), value: view.fixer?.model ?? `` }] }
                                : undefined
                        "
                    >
                        <Icon :name="pill.icon" :spin="pill.spin" class="text-2xs" />
                        {{ pill.label }}
                        <span v-if="attempts !== undefined" data-attempts class="font-normal text-subtle">· {{ attempts }}</span>
                    </component>

                    <!-- Ending the whole failure by hand, for when the reader knows better than the forge: quiet, and asked
                         first, since every workflow on it goes at once. -->
                    <Button
                        data-resolve
                        :label="t(`mainFailure.resolve`)"
                        size="small"
                        tier="quiet"
                        :loading="busy === resolveKey"
                        :disabled="busy !== undefined"
                        @click="resolving = true"
                    />

                    <!-- The run rows' own split button, moved up with the press: the caret re-points the model, and over an
                         agent that already tried, its panel ends in Continue / Start over. -->
                    <AgentRunButton
                        v-if="press !== undefined"
                        :label="press.label"
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

        <ConfirmDialog
            :open="resolving"
            :header="t(`mainFailure.resolveHeader`, { branch: failure.branch })"
            :description="t(`mainFailure.resolveDescription`)"
            :confirm-label="t(`mainFailure.resolve`)"
            :destructive="false"
            @cancel="resolving = false"
            @confirm="resolve"
        />

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
