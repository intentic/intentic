<script setup lang="ts">
import {
    type AgentSummary,
    ciFixConversationId,
    fixAttemptOf,
    type FixResume,
    fixStance,
    isPipelineInFlight,
    type PipelineRun,
} from "@intentic/sandbox-contract";
import {
    AgentRunButton,
    type AgentRunAttempt,
    type AgentRunChoice,
    appLink,
    Avatar,
    Button,
    DiffStat,
    DisclosureRow,
    fixStanceLook,
    formatTimestamp,
    Icon,
    Modal,
    StatusBadge,
    timeAgo,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { type ComponentPublicInstance, computed, ref } from "vue";
import type { CiFix } from "./ciFixes";
import { host } from "./host";
import PipelineDagGraph from "./PipelineDagGraph.vue";
import PipelineGraph from "./PipelineGraph.vue";
import { pipelineStages } from "./pipelineDag";
import { formatDuration, STATUS_TONE, triggerLabel } from "./statusVisual";
import { useRunJobs } from "./useRunJobs";

// One pipeline run row: fetches its own jobs on mount so the stage circles are readable without a click, and expands
// into the full job DAG. Stages are derived once here and handed to both renderers; the parent owns the action
// callbacks.

const props = defineProps<{
    run: PipelineRun;
    busy: string | undefined;
    // Job name to consecutive failing runs; lifted to the view, a fact no single row can see.
    recurring: ReadonlyMap<string, number>;
    // Whether this is the branch's open failure, and which run closed it, if any; sets how loud the row is.
    open: boolean;
    superseded: PipelineRun | undefined;
    // Default-open when still running on the branch's newest commit, or a failure it left open (`arrivesOpen`).
    autoOpen: boolean;
    // This row's own agent, if any (ciFixes.ts): its conversation id derives from this run. Turns the button into a
    // report instead of an offer to start.
    fix: AgentSummary | undefined;
    // Another run's agent working the same branch, for a row with none of its own; only set when `fix` isn't, so a red
    // row can't offer a second agent for work already in flight.
    branchFix: CiFix | undefined;
}>();
const emit = defineEmits<{
    rerun: [run: PipelineRun];
    cancel: [run: PipelineRun];
    // `resume` is the verb the caret's panel was ended with over an attempt that already exists; absent is the plain press.
    fix: [run: PipelineRun, pick: AgentRunChoice | undefined, resume: FixResume | undefined];
}>();

// vue-query caches per queryKey; each row owns its own entry, so remounts are free.
const runRef = computed(() => props.run);
const { jobs, isLoading: jobsLoading } = useRunJobs(runRef);
const stages = computed(() => pipelineStages(jobs.value));

// Seeded once from `autoOpen`, not bound: the row is keyed by its run (PipelinesView's `actionKey`), so later polls
// re-render it without resetting this. A closed row stays closed; a run finishing mid-view keeps its graph open.
const expanded = ref(props.autoOpen);
const fullscreen = ref(false);

// Run's identity for the parent's in-flight action tracking; the row is keyed to one run.
const actionKey = `${props.run.host}:${props.run.project}:${props.run.runId}`;

const tone = computed(() => STATUS_TONE[props.run.status]);
// Queued or going: the two states with something left to stop, so Cancel shows instead of Re-run.
const inFlight = computed(() => isPipelineInFlight(props.run.status));
const duration = computed(() => formatDuration(props.run.durationSeconds));
// Commit subject, or else the run's own id: repeating the branch/sha below would be redundant.
const headline = computed(() => props.run.title ?? `#${props.run.runId}`);
const trigger = computed(() => triggerLabel(props.run.trigger));
// Per-row model choice for this failure's fix, seeded via the host so button and daemon agree on cost. Cleared once
// started, so the next fix reopens on the standing list. The attempt already on this failure rides into the picker
// (read at open, off the fleet as it stands then), so its bar ends in Continue / Start over.
const fixModel = useAgentRunPick(
    () => host().models,
    `pipeline-fix`,
    () => attemptOnOffer.value,
);

const api = host();
const agentLink = (id: string): { href: string; onClick: (event: MouseEvent) => void } =>
    // `/agents/<id>` as the href, so ⌘-click opens a full tab like every other row on this board.
    // The plain click opens the conversation in the docked chat panel rather than navigating away.
    appLink(api.href(`/agents/${id}`), () => api.chat.openAgent(id));

// This row's own agent's fate, read once: drives the chip that replaces the button and its label when there's nothing
// left to report.
const fixState = computed(() => {
    const agent = props.fix;
    if (agent === undefined) {
        return undefined;
    }
    const stance = fixStance(agent);
    return { ...stance, ...fixStanceLook(stance.kind), link: agentLink(agent.id) };
});
// Branch's agent for a row with none of its own, in the same slot; its stance distinguishes a running turn from one
// parked on a question.
const branchState = computed(() => {
    const other = props.branchFix;
    if (other === undefined) {
        return undefined;
    }
    const stance = fixStance(other.agent);
    return { run: other.run, stance: { ...stance, ...fixStanceLook(stance.kind) }, link: agentLink(other.agent.id) };
});
// A landed fix hands the row's weight to Re-run: it's in the workspace, proving it is what's left.
const proven = computed(() => fixState.value?.kind === `landed`);

// Which attempt at this run the row's agent is (conversation-ids.ts): 1 wears the bare id, later ones their number.
const attemptNumber = computed(() =>
    props.fix === undefined ? undefined : fixAttemptOf(ciFixConversationId(props.run.repo, props.run.runId), props.fix.id),
);
// Only worth a word past the first: "attempt 1" on every chip would be noise, "attempt 3" is the story.
const attemptWord = computed(() => (attemptNumber.value === undefined || attemptNumber.value <= 1 ? undefined : `attempt ${attemptNumber.value}`));
/* THE ATTEMPT AS THE PICKER'S BAR NAMES IT (AgentRunAttempt): which, on what, how it stands; and whether it can be
 * continued from there, which only an ENDED one can. A landed attempt is history rather than an attempt on offer:
 * the run red again after it is a new failure wearing the same name. */
const attemptOnOffer = computed<AgentRunAttempt | undefined>(() => {
    const state = fixState.value;
    if (state === undefined || state.kind === `landed`) {
        return undefined;
    }
    const files = props.fix?.diff?.files ?? 0;
    const summary = [
        `Attempt ${attemptNumber.value ?? 1}`,
        props.fix?.model,
        state.label.toLowerCase(),
        files === 0 ? undefined : `${files} file${files === 1 ? `` : `s`} on its branch`,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
    return { summary, continuable: state.retry };
});

// Why the button is quiet: superseded (failure is over), behind a newer open failure (not the run to fix), or a branch
// agent already exists. The caret, not this text, says what a fix will spend.
const demoted = computed<string | undefined>(() => {
    if (props.branchFix !== undefined) {
        return `An agent is already working on ${props.run.branch}, started from run #${props.branchFix.run.runId}: open that one before starting a second.`;
    }
    if (props.open) {
        return undefined;
    }
    return props.superseded !== undefined
        ? `${props.run.branch} has passed since: this failure is history, but you can still start an agent on it`
        : `Behind a newer failure on ${props.run.branch}, that one is the run to fix`;
});
// Loud only on the branch's open failure, while no agent is already on it.
const loud = computed(() => props.open && props.branchFix === undefined);

// Precision matches the amount: a sub-cent turn still shows something.
const spend = computed<string | undefined>(() => {
    const usd = props.fix?.costUsd;
    return usd === undefined || usd === 0 ? undefined : usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
});
// Diff size, not just a file count, answers the question 'Fix ready' actually raises.
const fixDiff = computed(() => {
    const diff = props.fix?.diff;
    return diff === undefined || diff.files === 0 ? undefined : diff;
});

// Agent's age at chip width: one short token, not `timeAgo`'s sentence-length reading (which stays in the tooltip).
const compactAge = (at: number): string => {
    const minutes = Math.floor((Date.now() - at) / 60_000);
    if (minutes < 60) {
        // `<1m`, not `now`: 'Agent working now' reads redundant, 'Fix ready now' reads like an invitation.
        return minutes < 1 ? `<1m` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};
const fixAge = computed<string | undefined>(() => {
    const agent = props.fix;
    return agent === undefined ? undefined : compactAge(agent.startedAt ?? agent.updatedAt);
});
// A live turn is timed from its start; a settled one from when it last did anything.
const fixSince = computed<string | undefined>(() => {
    const agent = props.fix;
    if (agent === undefined) {
        return undefined;
    }
    return agent.startedAt === undefined ? timeAgo(agent.updatedAt) : `started ${timeAgo(agent.startedAt)}`;
});
// Spells out what the chip abbreviates, for the tooltip and screen reader. Model name and file count live only here;
// the chip's numbers say the same in fewer pixels.
const fixFacts = computed<string | undefined>(() => {
    const agent = props.fix;
    const state = fixState.value;
    if (agent === undefined || state?.kind === `landed`) {
        return undefined;
    }
    const files = agent.diff?.files ?? 0;
    return (
        [attemptWord.value, fixSince.value, agent.model, spend.value, files === 0 ? undefined : `${files} file${files === 1 ? `` : `s`}`]
            .filter((part) => part !== undefined)
            .join(` · `) || undefined
    );
});
// Age, spend and diff show while a fix is in play; once landed, the label is the whole report.
const showFixChipMeta = computed(() => fixState.value !== undefined && fixState.value.kind !== `landed`);
// Hint (fixStance's) followed by the facts behind the chip's numbers, parenthesised: the hint is a sentence, this is a
// list.
const fixDetail = computed<string | undefined>(() => {
    const state = fixState.value;
    if (state === undefined) {
        return undefined;
    }
    return fixFacts.value === undefined ? state.hint : `${state.hint} (${fixFacts.value})`;
});
// The chip in words: an `aria-label` replaces what's read, so a screen reader never gets the abbreviations directly.
const fixAria = computed<string | undefined>(() => {
    const state = fixState.value;
    if (state === undefined) {
        return undefined;
    }
    return `Fix agent: ${state.label.toLowerCase()}${fixFacts.value === undefined ? `` : `, ${fixFacts.value}`} — open the conversation`;
});

// One flowing line: the tooltip clamps as text, so a newline is just a space. What happened leads; why the button is
// quiet follows.
const startHint = computed<string | undefined>(
    () => [fixState.value?.retry === true ? fixDetail.value : undefined, demoted.value].filter((part) => part !== undefined).join(` `) || undefined,
);

const startFix = (): void => {
    emit(`fix`, props.run, fixModel.overridden.value ? fixModel.model.value : undefined, fixModel.resume.value);
    fixModel.clear();
};

// "Start over" beside a chip for an attempt still in play opens the picker rather than acting: the panel names the
// attempt, and its own button is the press that stops and files it away. No one-click path retires a working agent.
const startOver = ref<ComponentPublicInstance>();
const openStartOver = (): void => {
    const el = startOver.value?.$el as HTMLElement | undefined;
    if (el === undefined) {
        return;
    }
    void fixModel.choose(el, `Start over`).then((committed) => {
        if (committed) {
            startFix();
        }
    });
};
</script>

<template>
    <!--
        `hit="pair"`: the headline is a link to the vendor; swallowing it into the disclosure would conflate opening jobs with leaving the app.
        `wide-control`: the trailing cluster (graph, time, two buttons) may wrap to a second line rather than crowd the subject.
    -->
    <!-- @container: the chip's content is measured against this row, not the window, which the chat panel can halve. -->
    <DisclosureRow class="@container border-l-4" :class="tone.rowBorder" hit="pair" body="drawer" wide-control v-model:open="expanded">
        <template #lead="{ iconClass }">
            <Icon :name="tone.icon" :spin="tone.spin" class="shrink-0" :class="[iconClass, tone.text]" />
            <Avatar :size="24" :name="run.authorName" :src="run.authorAvatarUrl" />
        </template>

        <template #title>
            <div class="flex flex-wrap items-center gap-2">
                <a
                    :href="run.url"
                    target="_blank"
                    rel="noopener"
                    class="touch-target min-w-0 truncate text-sm font-medium text-content hover:text-link"
                    :title="headline"
                >
                    {{ headline }}
                </a>
                <StatusBadge :variant="tone.variant" :label="tone.label" size="xs" class="shrink-0" />
                <!-- Links to the later green run, not just naming it, so a reader can check the failed job actually ran there and wasn't skipped. -->
                <a
                    v-if="superseded"
                    :href="superseded.url"
                    target="_blank"
                    rel="noopener"
                    class="touch-target inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-px text-2xs font-medium text-subtle hover:text-link"
                    v-tooltip.top="`${run.branch} went green again in this run: open it to check the job that failed here even ran`"
                >
                    <Icon name="check-circle" class="text-2xs text-success" />
                    superseded by
                    <span class="font-mono">{{ superseded.sha.slice(0, 7) }}</span>
                </a>
                <!-- Only unusual origins earn a chip; a plain push is every repo's default. -->
                <span v-if="trigger" class="shrink-0 rounded border border-line px-1.5 py-px text-2xs font-medium text-subtle">
                    {{ trigger }}
                </span>
            </div>
        </template>

        <template #description>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-subtle">
                <span v-if="run.authorName" class="truncate font-medium text-muted">{{ run.authorName }}</span>
                <span class="inline-flex items-center gap-1">
                    <Icon name="code" class="text-2xs" />
                    <span class="font-mono">{{ run.branch }}</span>
                </span>
                <span class="font-mono text-subtle/70">{{ run.sha.slice(0, 7) }}</span>
                <span v-if="duration" class="inline-flex items-center gap-1">
                    <Icon name="clock" class="text-2xs" />
                    {{ duration }}
                </span>
            </span>
        </template>

        <template #control>
            <!--
                Stages and actions both wrap, or two buttons that refuse to shrink squeeze the circles the row exists to show.
                `ml-auto`+`justify-end` keeps them right-aligned either way.
            -->
            <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
                <!--
                    `basis-0` with a ~3-circle floor: the graph is the one element here that can give ground, but not below legibility. Takes its
                    natural width when the line has room (`max-w-max`), scrolls past that.
                -->
                <!--
                    Padding is `hover:scale-110`'s headroom: without it, a scaled circle overflows the box's exact-fit size and flashes both
                    scrollbars.
                -->
                <div class="scrollbar-thin flex max-w-max min-w-24 flex-1 basis-0 items-center overflow-x-auto p-1">
                    <PipelineGraph v-if="stages.length > 0" :stages="stages" :recurring="recurring" />
                    <!--
                        Same circles-and-connectors geometry as the real graph, so the row doesn't re-flow once jobs land. Three is a placeholder
                        guess.
                    -->
                    <div v-else-if="jobsLoading" class="flex items-center" aria-hidden="true">
                        <template v-for="i in 3" :key="i">
                            <span v-if="i > 1" class="h-px w-3 shrink-0 bg-line"></span>
                            <span class="skeleton h-6 w-6 shrink-0 rounded-full"></span>
                        </template>
                    </div>
                </div>

                <!-- Time + actions -->
                <div class="flex shrink-0 items-center gap-2">
                    <span class="text-2xs text-subtle" :title="formatTimestamp(run.createdAt)">
                        {{ timeAgo(run.createdAt) }}
                    </span>
                    <div class="flex items-center gap-1">
                        <!--
                            Branch's agent, for a row with none of its own; the demoted button's tooltip only explains, this is the press that acts
                            on it. Neutral colour: it isn't this run's own agent.
                        -->
                        <a
                            v-if="branchState"
                            v-bind="branchState.link"
                            class="touch-target inline-flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-xs font-medium text-subtle hover:bg-overlay hover:text-content"
                            v-tooltip.top="demoted"
                            :aria-label="`An agent is already working on ${run.branch}, started from run #${branchState.run.runId} — open it`"
                        >
                            <Icon :name="branchState.stance.icon" :spin="branchState.stance.spin" class="text-2xs" />
                            Agent on branch
                        </a>
                        <!--
                            One slot for the agent, whichever half of its life applies (fixStance.ts owns the words). Stays even after the run goes
                            green: a rerun keeps the vendor's run id. Carries the full report while in play; once landed, only the label remains.
                        -->
                        <a
                            v-if="fixState !== undefined && !fixState.retry"
                            v-bind="fixState.link"
                            class="touch-target inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium"
                            :class="[fixState.ink, fixState.chip]"
                            v-tooltip.top="fixDetail"
                            :aria-label="fixAria"
                        >
                            <Icon :name="fixState.icon" :spin="fixState.spin" class="text-2xs" />
                            {{ fixState.label }}
                            <span v-if="showFixChipMeta && fixAge" class="text-2xs font-normal tabular-nums text-subtle">{{ fixAge }}</span>
                            <span v-if="showFixChipMeta && spend" class="hidden text-2xs font-normal tabular-nums text-subtle @3xl:inline">{{
                                spend
                            }}</span>
                            <DiffStat
                                v-if="showFixChipMeta && fixDiff"
                                class="hidden @3xl:inline"
                                :additions="fixDiff.insertions"
                                :deletions="fixDiff.deletions"
                            />
                        </a>
                        <!--
                            Beside a chip for an attempt still in play: the one decision left from here, and it only opens the picker, whose bar
                            is the press that stops and files the attempt away (openStartOver). Not offered once the fix has landed, which is history.
                        -->
                        <Button
                            v-if="fixState !== undefined && fixState.ongoing && run.status === `failed`"
                            ref="startOver"
                            label="Start over"
                            size="small"
                            severity="secondary"
                            text
                            icon-pos="right"
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            v-tooltip.top="`Set this attempt aside and start a fresh one — opens the picker first`"
                            @click="openStartOver"
                        >
                            <template #icon><Icon name="chevron-down" class="text-2xs" /></template>
                        </Button>
                        <!--
                            Primary only on the branch's open failure with no agent already on it; every other red row stays at Re-run's weight.
                            'Continue' carries on in the same conversation (id derives from the run) rather than starting a rival agent; its caret's
                            panel is where Start over lives, since deviating from the safe press should cost a look at what it replaces.
                        -->
                        <AgentRunButton
                            v-else-if="run.status === `failed`"
                            :label="fixState?.retry === true ? `Continue` : `Fix with agent`"
                            :picker="fixModel"
                            :severity="loud ? undefined : `secondary`"
                            :text="!loud"
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            :hint="startHint"
                            @run="startFix"
                        />
                        <!--
                            Offered for a queued run too: waiting on a runner that never comes is exactly when Cancel is wanted, and both forges
                            accept it pre-start.
                        -->
                        <Button
                            v-if="inFlight"
                            label="Cancel"
                            size="small"
                            severity="secondary"
                            text
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            @click="emit(`cancel`, run)"
                        />
                        <!--
                            Last rung: fix, review, land, prove it. Takes the weight the Fix button gives up once the fix has landed in the
                            workspace.
                        -->
                        <Button
                            v-else
                            label="Re-run"
                            size="small"
                            :severity="proven ? undefined : `secondary`"
                            :text="!proven"
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            :title="proven ? `The fix is in your workspace: run the pipeline again to prove it` : undefined"
                            @click="emit(`rerun`, run)"
                        />
                    </div>
                </div>
            </div>
        </template>

        <!-- Expanded shows only the job graph: the agent facts it once repeated here now live entirely on the header chip. -->
        <template #below>
            <div v-if="jobsLoading" class="flex flex-col gap-2" role="status" aria-busy="true" aria-label="Loading jobs">
                <div class="flex h-36 items-center gap-3 overflow-hidden rounded-lg border border-line bg-canvas px-4">
                    <template v-for="i in 3" :key="i">
                        <span v-if="i > 1" class="h-px w-6 shrink-0 bg-line"></span>
                        <span class="skeleton h-12 w-48 shrink-0 rounded-md"></span>
                    </template>
                </div>
            </div>

            <PipelineDagGraph v-else-if="stages.length > 0" :stages="stages" :recurring="recurring" @expand="fullscreen = true" />

            <div v-else-if="run.failedJobs?.length">
                <div class="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Failed jobs</div>
                <div class="flex flex-wrap gap-1.5">
                    <span
                        v-for="job in run.failedJobs"
                        :key="job"
                        class="inline-flex items-center gap-1 rounded-md border border-danger/20 bg-danger/5 px-2 py-1 text-xs font-medium text-danger"
                    >
                        <Icon name="exclamation-circle" class="text-2xs" />
                        {{ job }}
                    </span>
                </div>
            </div>

            <p v-else class="py-2 text-xs text-muted">No job details available for this run.</p>

            <!--
                Same graph, given the window: worth reading whole exactly when panning inside the row would be needed. A separate instance, so its
                pin and pan stay independent of the inline one.
            -->
            <Modal v-model:open="fullscreen" size="full" :scroll="false" :header="`${headline}: job graph`">
                <PipelineDagGraph :stages="stages" :recurring="recurring" fill />
            </Modal>
        </template>
    </DisclosureRow>
</template>
