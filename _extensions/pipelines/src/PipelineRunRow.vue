<script setup lang="ts">
import type { PipelineRun } from "@intentic/sandbox-contract";
import { Button, Icon, StatusBadge, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import AuthorAvatar from "./AuthorAvatar.vue";
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
}>();
const emit = defineEmits<{
    rerun: [run: PipelineRun];
    cancel: [run: PipelineRun];
    fix: [run: PipelineRun];
}>();

// vue-query caches per queryKey, so each row owns its own entry and remounts are free.
const runRef = computed(() => props.run);
const { jobs, isLoading: jobsLoading } = useRunJobs(runRef);
const stages = computed(() => pipelineStages(jobs.value));

const expanded = ref(false);

// The run's identity for the parent's in-flight action tracking. A row instance is keyed to one run, so this
// never has to recompute.
const actionKey = `${props.run.host}:${props.run.project}:${props.run.runId}`;

const tone = computed(() => STATUS_TONE[props.run.status]);
const duration = computed(() => formatDuration(props.run.durationSeconds));
// The commit subject is the headline. Without one, the vendor's own name for an unnamed pipeline — its id —
// beats repeating the branch and sha that the line below already carries.
const headline = computed(() => props.run.title ?? `#${props.run.runId}`);
const trigger = computed(() => triggerLabel(props.run.trigger));
const jobCount = computed(() => stages.value.reduce((total, stage) => total + stage.jobs.length, 0));
</script>

<template>
    <div
        class="group border-l-[3px] transition-colors"
        :class="[tone.rowBorder, expanded ? `bg-content/[0.02]` : `hover:bg-content/[0.02]`]"
    >
        <!-- Run header row -->
        <div class="flex w-full items-center gap-3 px-4 py-3">
            <Icon :name="tone.icon" class="shrink-0 text-base" :class="[tone.text, tone.spin ? `animate-spin` : ``]" />

            <AuthorAvatar :name="run.authorName" :avatar-url="run.authorAvatarUrl" />

            <!-- Pipeline info -->
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <a
                        :href="run.url"
                        target="_blank"
                        rel="noopener"
                        class="min-w-0 truncate text-sm font-medium text-content hover:text-link"
                        :title="headline"
                    >
                        {{ headline }}
                    </a>
                    <StatusBadge :variant="tone.variant" :label="tone.label" size="xs" class="shrink-0" />
                    <!-- Only unusual origins earn a chip; a plain push is every repo's default. -->
                    <span
                        v-if="trigger"
                        class="shrink-0 rounded border border-line px-1.5 py-px text-2xs font-medium text-subtle"
                    >
                        {{ trigger }}
                    </span>
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
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
                </div>
            </div>

            <!-- Inline stage graph -->
            <div class="flex shrink-0 items-center">
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
                <span class="text-2xs text-subtle" :title="new Date(run.createdAt).toLocaleString()">
                    {{ timeAgo(run.createdAt) }}
                </span>
                <div class="flex items-center gap-1">
                    <Button
                        v-if="run.status === `failed`"
                        label="Fix with agent"
                        size="small"
                        :loading="busy === actionKey"
                        :disabled="busy !== undefined"
                        @click="emit(`fix`, run)"
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
                <button
                    type="button"
                    class="cursor-pointer p-1"
                    :title="expanded ? `Hide job graph` : `Show job graph`"
                    @click="expanded = !expanded"
                >
                    <Icon
                        name="chevron-down"
                        class="text-2xs text-subtle transition-transform"
                        :class="expanded ? `rotate-180` : ``"
                    />
                </button>
            </div>
        </div>

        <!-- Expanded: the run's job graph -->
        <div v-if="expanded" class="border-t border-line px-4 pb-4 pt-3">
            <!-- The heading is known before the jobs are, so it stays real text and only the graph band is a
                 placeholder — sized to DagGraph's own floor (150px) so the row settles once, not twice. -->
            <div v-if="jobsLoading" class="flex flex-col gap-2" role="status" aria-busy="true" aria-label="Loading jobs">
                <div class="flex items-center justify-between">
                    <span class="text-2xs font-semibold uppercase tracking-wide text-subtle">Job graph</span>
                    <span class="skeleton h-2.5 w-40"></span>
                </div>
                <div class="flex h-[150px] items-center gap-3 overflow-hidden rounded-lg border border-line bg-canvas px-4">
                    <template v-for="i in 3" :key="i">
                        <span v-if="i > 1" class="h-px w-6 shrink-0 bg-line"></span>
                        <span class="skeleton h-[52px] w-[200px] shrink-0 rounded-md"></span>
                    </template>
                </div>
            </div>

            <div v-else-if="stages.length > 0" class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <span class="text-2xs font-semibold uppercase tracking-wide text-subtle">Job graph</span>
                    <span class="text-2xs text-subtle">
                        {{ stages.length }} {{ stages.length === 1 ? `stage` : `stages` }} ·
                        {{ jobCount }} {{ jobCount === 1 ? `job` : `jobs` }} · drag to pan, scroll to zoom
                    </span>
                </div>
                <PipelineDagGraph :stages="stages" />
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
        </div>
    </div>
</template>
