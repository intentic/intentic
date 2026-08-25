<script setup lang="ts">
import type { PipelineRun } from "@intentic/sandbox-contract";
import {
    AgentRunButton,
    type AgentRunChoice,
    Avatar,
    Button,
    DisclosureRow,
    formatTimestamp,
    Icon,
    Modal,
    StatusBadge,
    timeAgo,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
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

const expanded = ref(false);
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
const jobCount = computed(() => stages.value.reduce((total, stage) => total + stage.jobs.length, 0));

/* WHICH MODEL THIS ROW'S FIX WILL SPEND, and the caret that re-points it for this failure alone. Seeded from
 * the sandbox's agent-run list, which is also what the daemon will resolve if nobody touches it: asked of the
 * host rather than read here, so the two cannot disagree about what a click costs.
 *
 * Per ROW rather than per view: the choice belongs to the failure you are looking at, and the whole reason to
 * reach for a bigger model is that this particular one beat the standing order. Cleared once the run has
 * started, so the next fix on the same row opens on the standing list again. */
const fixModel = useAgentRunPick(() => host().models);

/* WHY THE BUTTON IS QUIET, for a demoted one: a Fix button at Re-run's weight reads as broken otherwise. The
 * two reasons differ enough to be worth different words: a superseded failure is over, while a failure behind
 * the head of an open breakage is very much alive, just not the run to start from.
 *
 * What it will SPEND is no longer part of this sentence: the caret beside it says that, and says it in one
 * place for every surface in the app that starts an agent. */
const fixHint = computed<string | undefined>(() => {
    if (props.open) {
        return undefined;
    }
    return props.superseded !== undefined
        ? `${props.run.branch} has passed since: this failure is history, but you can still start an agent on it`
        : `Behind a newer failure on ${props.run.branch}, that one is the run to fix`;
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
    <DisclosureRow class="border-l-4" :class="tone.rowBorder" density="comfortable" hit="pair" body="drawer" wide-control v-model:open="expanded">
        <template #lead>
            <Icon :name="tone.icon" class="shrink-0 text-base" :class="[tone.text, tone.spin ? `animate-spin` : ``]" />
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
                        <!-- Primary only on the branch's open failure. Every other red row keeps the same action at
                             Re-run's weight: a log entry, not a demand, while the vendor's own re-runs and skipped
                             jobs mean a green above is evidence, not proof, so the action stays one click away. -->
                        <AgentRunButton
                            v-if="run.status === `failed`"
                            label="Fix with agent"
                            :model-label="fixModel.model.value.label"
                            :overridden="fixModel.overridden.value"
                            :severity="open ? undefined : `secondary`"
                            :text="!open"
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            :hint="fixHint"
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
                        <Button
                            v-else
                            label="Re-run"
                            size="small"
                            severity="secondary"
                            text
                            :loading="busy === actionKey"
                            :disabled="busy !== undefined"
                            @click="emit(`rerun`, run)"
                        />
                    </div>
                </div>
            </div>
        </template>

        <!-- Expanded: the run's job graph -->
        <template #below>
            <!-- The heading is known before the jobs are, so it stays real text and only the graph band is a
                 placeholder: sized to DagGraph's own floor (150px) so the row settles once, not twice. -->
            <div v-if="jobsLoading" class="flex flex-col gap-2" role="status" aria-busy="true" aria-label="Loading jobs">
                <div class="flex items-center justify-between">
                    <span class="text-2xs font-semibold uppercase tracking-wide text-subtle">Job graph</span>
                    <span class="skeleton h-2.5 w-40"></span>
                </div>
                <div class="flex h-36 items-center gap-3 overflow-hidden rounded-lg border border-line bg-canvas px-4">
                    <template v-for="i in 3" :key="i">
                        <span v-if="i > 1" class="h-px w-6 shrink-0 bg-line"></span>
                        <span class="skeleton h-12 w-48 shrink-0 rounded-md"></span>
                    </template>
                </div>
            </div>

            <div v-else-if="stages.length > 0" class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <span class="text-2xs font-semibold uppercase tracking-wide text-subtle">Job graph</span>
                    <!-- The pan/zoom instructions that used to live here are on the canvas now, as controls
                         rather than as a sentence about controls. -->
                    <span class="text-2xs text-subtle">
                        {{ stages.length }} {{ stages.length === 1 ? `stage` : `stages` }} · {{ jobCount }} {{ jobCount === 1 ? `job` : `jobs` }}
                    </span>
                </div>
                <PipelineDagGraph :stages="stages" :recurring="recurring" @expand="fullscreen = true" />
            </div>

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
