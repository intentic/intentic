<script setup lang="ts">
import type { AgentSummary, PipelineRun } from "@intentic/sandbox-contract";
import {
    AgentRunButton,
    type AgentRunChoice,
    appLink,
    Avatar,
    Button,
    DiffStat,
    DisclosureRow,
    formatTimestamp,
    Icon,
    Modal,
    StatusBadge,
    timeAgo,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import type { CiFix } from "./ciFixes";
import { fixStance } from "./fixStance";
import { host } from "./host";
import PipelineDagGraph from "./PipelineDagGraph.vue";
import PipelineGraph from "./PipelineGraph.vue";
import { pipelineStages } from "./pipelineDag";
import { formatDuration, STATUS_TONE, triggerLabel } from "./statusVisual";
import { useRunJobs } from "./useRunJobs";

/* One pipeline run row. It fetches its own jobs on mount so the inline stage circles are there to read
 * without a click, and expands into the full job DAG. Stages are derived once here and handed to both
 * renderers. The parent owns the action callbacks. */

const props = defineProps<{
    run: PipelineRun;
    busy: string | undefined;
    // Job name → consecutive runs it has been failing on this branch. Lifted to the view because it is a fact
    // ACROSS runs, which no single row can see.
    recurring: ReadonlyMap<string, number>;
    // Whether this failure is the branch's open problem, and: if a later run went green, which one closed it.
    // Both are cross-run facts too, and together they set how loudly the row asks to be fixed.
    open: boolean;
    superseded: PipelineRun | undefined;
    // Whether this row's graph should be on screen without a click: this run is still going, on the newest
    // commit its branch has (ciStreaks' `runningOnHead`). A third cross-run fact, and a DEFAULT, not a state.
    autoOpen: boolean;
    /* THE AGENT THIS ROW ALREADY SENT, if it did (ciFixes.ts): the fleet card for the conversation whose id is
     * derived from this very run. It is what turns the button into a report, and it is the reason the row can
     * stop offering to start what is already running. */
    fix: AgentSummary | undefined;
    /* …and the one working on ANOTHER run of the same branch, for a row that has no agent of its own. A fix is
     * attached to a run; a breakage belongs to a branch, so without this the newest red row would cheerfully
     * offer a second agent for work already in flight one row down. Only ever set when `fix` is not. */
    branchFix: CiFix | undefined;
}>();
const emit = defineEmits<{
    rerun: [run: PipelineRun];
    cancel: [run: PipelineRun];
    fix: [run: PipelineRun, pick: AgentRunChoice | undefined];
}>();

// vue-query caches per queryKey, so each row owns its own entry and remounts are free.
const runRef = computed(() => props.run);
const { jobs, isLoading: jobsLoading } = useRunJobs(runRef);
const stages = computed(() => pipelineStages(jobs.value));

/* A LIVE RUN OPENS ITSELF, and `autoOpen` is a seed rather than a binding on purpose.
 *
 * A row is keyed by its run (PipelinesView's `actionKey`), so this instance is created once, when the run first
 * appears in the list, and the 30s poll behind the board re-renders it without touching this ref again. That is
 * the whole mechanism, and it is what makes the three cases come out right: a pipeline that starts while the
 * board is open arrives as a NEW row and opens on the same rule; a row the reader closed stays closed, because
 * nothing re-applies the default; and a run that FINISHES under the reader keeps its graph on screen, because a
 * bound `open` would collapse it at the exact moment it says whether it passed. */
const expanded = ref(props.autoOpen);
const fullscreen = ref(false);

// The run's identity for the parent's in-flight action tracking. A row instance is keyed to one run, so this
// never has to recompute.
const actionKey = `${props.run.host}:${props.run.project}:${props.run.runId}`;

const tone = computed(() => STATUS_TONE[props.run.status]);
const duration = computed(() => formatDuration(props.run.durationSeconds));
// The commit subject is the headline. Without one, the vendor's own name for an unnamed pipeline: its id:
// beats repeating the branch and sha that the line below already carries.
const headline = computed(() => props.run.title ?? `#${props.run.runId}`);
const trigger = computed(() => triggerLabel(props.run.trigger));
/* WHICH MODEL THIS ROW'S FIX WILL SPEND, and the caret that re-points it for this failure alone. Seeded from
 * the sandbox's agent-run list, which is also what the daemon will resolve if nobody touches it: asked of the
 * host rather than read here, so the two cannot disagree about what a click costs.
 *
 * Per ROW rather than per view: the choice belongs to the failure you are looking at, and the whole reason to
 * reach for a bigger model is that this particular one beat the standing order. Cleared once the run has
 * started, so the next fix on the same row opens on the standing list again. */
const fixModel = useAgentRunPick(() => host().models);

const api = host();
const agentLink = (id: string): { href: string; onClick: (event: MouseEvent) => void } =>
    // `/agents/<id>` is the one destination every state wants: it focuses the conversation in the docked chat
    // AND carries the review of what the agent wrote, so a question and a finished diff are both one press
    // away. A real anchor, so ⌘-click opens a tab like every other row on this board.
    appLink(api.href(`/agents/${id}`), () => api.navigate(`/agents/${id}`));

/* WHAT BECAME OF THIS ROW'S OWN AGENT, read once and used three times: the chip that replaces the button, the
 * button's label when there is nothing left to report, and the strip inside the drawer. */
const fixState = computed(() => {
    const agent = props.fix;
    return agent === undefined ? undefined : { ...fixStance(agent), agent, link: agentLink(agent.id) };
});
const branchState = computed(() => {
    const other = props.branchFix;
    return other === undefined ? undefined : { run: other.run, link: agentLink(other.agent.id) };
});
// A landed fix hands the row's weight to Re-run: the fix is in the workspace, and what is left is proving it.
const proven = computed(() => fixState.value?.kind === `landed`);

/* WHY THE BUTTON IS QUIET, for a demoted one: a Fix button at Re-run's weight reads as broken otherwise. The
 * three reasons differ enough to be worth different words. A superseded failure is over; a failure behind the
 * head of an open breakage is very much alive, just not the run to start from; and a branch that already has
 * an agent on it wants that agent opened, not a second one started beside it.
 *
 * What it will SPEND is no longer part of this sentence: the caret beside it says that, and says it in one
 * place for every surface in the app that starts an agent. */
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
// One flowing line rather than a list: the tooltip renders as text into a clamped strip, so a newline is a
// space and a third sentence falls off the bottom. What happened leads; why the button is quiet follows.
const startHint = computed<string | undefined>(() =>
    [fixState.value?.retry === true ? fixState.value.hint : undefined, demoted.value].filter((part) => part !== undefined).join(` `) || undefined,
);
// Loud only on the branch's open failure, and only while nobody is already on it.
const loud = computed(() => props.open && props.branchFix === undefined);

// What the agent has spent, at the precision the number deserves: a sub-cent turn still shows something.
const spend = computed<string | undefined>(() => {
    const usd = props.fix?.costUsd;
    return usd === undefined || usd === 0 ? undefined : usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
});
// A live turn is timed from its start; a settled one from when it last did anything.
const fixSince = computed<string | undefined>(() => {
    const agent = props.fix;
    if (agent === undefined) {
        return undefined;
    }
    return agent.startedAt === undefined ? timeAgo(agent.updatedAt) : `started ${timeAgo(agent.startedAt)}`;
});

const startFix = (): void => {
    emit(`fix`, props.run, fixModel.overridden.value ? fixModel.model.value : undefined);
    fixModel.clear();
};
</script>

<template>
    <!-- THE DISCLOSURE MOVED TO THE LEFT EDGE. It was a bare `chevron-down` rotated 180° at the far right of the
         verb cluster, with no `aria-expanded` and a `title` for a label — the ports list's mistake in a
         different costume: a navigation control filed among Cancel, Re-run and "Fix with agent".

         `hit="pair"` because this row's headline is a LINK to the run on the vendor; swallowing it into the
         disclosure would make "show me the jobs" and "leave the app" the same press. `wideControl` because the
         trailing cluster is a SET (a stage graph, a time, two buttons) that has to be allowed to take a second
         line rather than squeeze the commit subject to nothing — see <Row>'s own note on the prop. -->
    <DisclosureRow class="border-l-4" :class="tone.rowBorder" hit="pair" body="drawer" wide-control v-model:open="expanded">
        <template #lead>
            <Icon :name="tone.icon" :spin="tone.spin" class="shrink-0 text-base" :class="tone.text" />
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
                <!-- Qualifies the verdict, so it sits with it: the run failed, and the branch has recovered
                         since. Links to the green rather than just naming it: checking whether the job that
                         failed here even ran there is the one way to catch a "pass" that only skipped it. -->
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
            <!-- The stages and what you can do about them. They wrap between themselves as well, because the
                 alternative is the stage circles being squeezed to a sliver by two buttons that refuse to shrink:
                 and the circles are what the row is FOR. `ml-auto` + `justify-end` keeps them to the right of
                 whichever line they land on. -->
            <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
                <!-- Inline stage graph. `basis-0` with a floor of ~three circles, because the graph is the one
                     item here that can give: sized from its content it would count its full length toward the
                     wrap and break a row that had room for it, and with no floor at all it would be squeezed to
                     a sliver by two buttons that never shrink. So it asks for three circles, takes its natural
                     width when the line has it (`max-w-max`), and scrolls when a twelve-stage run has more. -->
                <!-- The padding is the hover scale's headroom: a transformed element counts toward the
                     container's scrollable overflow, and the box is otherwise exactly the circles' size, so
                     `hover:scale-110` poked a pixel past it on both axes and flashed both scrollbars. -->
                <div class="scrollbar-thin flex max-w-max min-w-24 flex-1 basis-0 items-center overflow-x-auto p-1">
                    <PipelineGraph v-if="stages.length > 0" :stages="stages" :recurring="recurring" />
                    <!-- Same circles-and-connectors geometry as the real graph, so the row does not re-flow around
                         it when the jobs land. Three is the guess; the count is what we are waiting to learn. -->
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
                        <!-- ONE SLOT FOR THE AGENT, whichever half of its life the row is looking at. The board
                             could only ever say "Fix with agent", including to the reader whose agent was at that
                             moment parked on a question nobody would ever see; so the same slot reports instead as
                             soon as there is something to report (fixStance.ts owns the words).

                             It stays a state even on a run that has since gone green: a rerun keeps the vendor's
                             run id, and an agent still working on the failure it USED to have is worth saying. -->
                        <a
                            v-if="fixState !== undefined && !fixState.retry"
                            v-bind="fixState.link"
                            class="touch-target inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs font-medium"
                            :class="[fixState.ink, fixState.chip]"
                            v-tooltip.top="fixState.hint"
                            :aria-label="`Fix agent: ${fixState.label.toLowerCase()} — open the conversation`"
                        >
                            <Icon :name="fixState.icon" :spin="fixState.spin" class="text-2xs" />
                            {{ fixState.label }}
                        </a>
                        <!-- Primary only on the branch's open failure, and only while no agent is already on that
                             branch. Every other red row keeps the same action at Re-run's weight: a log entry, not
                             a demand, while the vendor's own re-runs and skipped jobs mean a green above is
                             evidence, not proof, so the action stays one click away.

                             "Try again" is the same press on a fix that ENDED: the conversation id is derived from
                             the run, so it carries on in that conversation, on its branch, rather than opening a
                             rival agent beside it. The caret matters most here, an agent that just failed is the
                             one case where reaching for a bigger model is the whole point. -->
                        <AgentRunButton
                            v-else-if="run.status === `failed`"
                            :label="fixState?.retry === true ? `Try again` : `Fix with agent`"
                            :model-label="fixModel.model.value.label"
                            :overridden="fixModel.overridden.value"
                            :severity="loud ? undefined : `secondary`"
                            :text="!loud"
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            :hint="startHint"
                            @run="startFix"
                            @pick="fixModel.choose"
                        />
                        <Button
                            v-if="run.status === `running`"
                            label="Cancel"
                            size="small"
                            severity="secondary"
                            text
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            @click="emit(`cancel`, run)"
                        />
                        <!-- THE LAST RUNG OF THE LADDER. Fix → review → land → prove it, and once the fix is in the
                             workspace the useful press on a still-red row is this one, so it takes the weight the
                             Fix button has just given up. Nothing else on the board knows enough to say that. -->
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

        <!-- Expanded: the run's job graph -->
        <template #below>
            <!-- THE AGENT, IN FULL, where a row has the width for it. The collapsed line gets one word about the
                 fix because it is scanned; everything that answers "how is it going, what has it cost me, what
                 did it write" is read deliberately, which is what opening a row IS. Same placement (and the same
                 reasoning) as ext-maintenance's run line. -->
            <div v-if="fixState" class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                <span class="inline-flex items-center gap-1 font-medium" :class="fixState.ink">
                    <Icon :name="fixState.icon" :spin="fixState.spin" />
                    {{ fixState.label }}
                </span>
                <span v-if="fixSince">{{ fixSince }}</span>
                <span v-if="fixState.agent.model" class="font-mono">{{ fixState.agent.model }}</span>
                <span v-if="spend">{{ spend }}</span>
                <span v-if="fixState.agent.diff && fixState.agent.diff.files > 0" class="inline-flex items-center gap-1.5">
                    {{ fixState.agent.diff.files }} file{{ fixState.agent.diff.files === 1 ? `` : `s` }}
                    <DiffStat :additions="fixState.agent.diff.insertions" :deletions="fixState.agent.diff.deletions" />
                </span>
                <a v-bind="fixState.link" class="touch-target underline hover:text-content">open the conversation</a>
            </div>

            <!-- A row with no agent of its own, on a branch that has one. The collapsed line can only demote its
                 button and say so in a tooltip; this is where the sentence gets a link, because "open that one
                 instead" is not advice anybody can act on without one. -->
            <p v-else-if="branchState" class="mb-3 text-2xs text-subtle">
                An agent is already working on <span class="font-mono">{{ run.branch }}</span
                >, started from run #{{ branchState.run.runId }} —
                <a v-bind="branchState.link" class="touch-target underline hover:text-content">open it</a>
            </p>

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

            <!-- THE SAME GRAPH, GIVEN THE WINDOW. A run wide enough to need panning inside a row is exactly the
                 one worth reading whole, and the band in a list of rows can never be that. Its own component
                 instance, so the trace pinned in the small one does not follow you in and the pan you leave
                 behind is still there when you close. -->
            <Modal v-model:open="fullscreen" size="full" :scroll="false" :header="`${headline}: job graph`">
                <PipelineDagGraph :stages="stages" :recurring="recurring" fill />
            </Modal>
        </template>
    </DisclosureRow>
</template>
