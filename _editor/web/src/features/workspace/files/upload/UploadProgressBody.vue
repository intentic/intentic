<script setup lang="ts">
import { formatBytes, formatElapsed } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed, onBeforeUnmount, watch } from "vue";
import { useUploadQueue } from "./useUploadQueue";
import { useT } from "@intentic/ui/i18n";

// Detail under an import's headline: progress bar, per-folder breakdown, failures, dependency offer. Phase and its
// headline sentence live in notificationSources.ts; retirement timers live here: a clean finish dismisses quickly, one
// that started an install stays longer, a failure never retires.

const t = useT();

const {
    fileCount,
    bytesDone,
    bytesTotal,
    currentName,
    finished,
    scanning,
    scannedCount,
    scanningName,
    unreadableCount,
    skippedNotice,
    failedCount,
    groups,
    failures,
    throughput,
    secondsLeft,
    setupProjects,
    installAfterUpload,
    setInstallAfterUpload,
    installQueued,
    installError,
    installSettled,
    dismiss,
} = useUploadQueue();

// The host's gap class lands on this component's root, which some phases don't have; bound by hand so Vue never
// tries to inherit it onto nothing.
defineOptions({ inheritAttrs: false });

const pct = computed(() => (bytesTotal.value === 0 ? 100 : Math.min(100, Math.round((bytesDone.value / bytesTotal.value) * 100))));

// Shown while bytes are in flight or failed; a clean finish's headline already says it all.
const breakdown = computed(() => fileCount.value > 0 && !(finished.value && failedCount.value + unreadableCount.value === 0));

// The rest of the time at the pace so far, once there is a pace worth extrapolating from.
const timeLeft = computed(() =>
    finished.value || secondsLeft.value === undefined ? undefined : t(`workspace.uploadProgressBody.timeLeft`, { time: formatElapsed(secondsLeft.value) }),
);

// The scan line, which needs either a count or a name to say anything.
const scanLine = computed(() => scanning.value && (fileCount.value > 0 || scanningName.value !== ``));

// Offer shown for the whole upload (not a dialog or prompt), so drag-and-drop still just works, with time to uncheck
// it. One row per project; label names the file read (e.g. "pnpm · pnpm-lock.yaml") so the pick isn't opaque.
const setupSummary = computed(() =>
    setupProjects.value.map((project) => ({
        dir: project.dir === `` ? t(`workspace.uploadProgressBody.workspaceRoot`) : project.dir,
        label: `${project.recipe.manager} · ${project.recipe.evidence}`,
    })),
);

// A clean finish leaves nothing under the headline; rendering no element at all is what keeps the card's gap row
// from being reserved for an empty box.
const drawn = computed(() => scanLine.value || breakdown.value || setupSummary.value.length > 0);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(
    [finished, installSettled],
    ([isFinished, isSettled]) => {
        // Holds until install settles, so a clean finish can't vanish before saying what it kicked off.
        if (isFinished && failedCount.value + unreadableCount.value === 0 && isSettled && installError.value === undefined) {
            timer = setTimeout(dismiss, installQueued.value.length > 0 ? 6000 : 3000);
        }
    },
    { immediate: true },
);
// A "nothing to upload" notice is informational: auto-dismiss it like a clean finish.
watch(skippedNotice, (notice) => {
    if (notice !== undefined) {
        timer = setTimeout(dismiss, 4000);
    }
});
onBeforeUnmount(() => {
    if (timer !== undefined) {
        clearTimeout(timer);
    }
});
</script>

<template>
    <div v-if="drawn" v-bind="$attrs" class="text-xs text-content">
        <!-- Still scanning while files are already uploading; the headline belongs to the upload by then. -->
        <p v-if="scanning && fileCount > 0" class="mb-2 truncate border-b border-line pb-2 text-2xs text-subtle">
            {{ t(`workspace.uploadProgressBody.scanningFiles`, { count: scannedCount }, scannedCount)
            }}<template v-if="scanningName !== ``"> · {{ scanningName }}</template>
        </p>
        <!-- Nothing sent yet: the headline already carries the count; this just says where the walk has got to. -->
        <p v-else-if="scanning && scanningName !== ``" class="truncate text-2xs text-subtle">{{ scanningName }}</p>

        <template v-if="breakdown">
            <div class="h-1 overflow-hidden rounded bg-overlay">
                <div class="h-full rounded bg-primary-500 transition-[width] duration-200" :style="{ width: `${pct}%` }"></div>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 text-2xs text-subtle">
                <span>{{ formatBytes(bytesDone) }} / {{ formatBytes(bytesTotal) }}</span>
                <span v-if="!finished" class="truncate">
                    {{ formatBytes(throughput) }}/s<template v-if="timeLeft !== undefined"> · {{ timeLeft }}</template>
                </span>
            </div>
            <p v-if="!finished && currentName !== ``" class="mt-0.5 truncate text-2xs text-subtle">{{ currentName }}</p>

            <!-- Per-folder breakdown: what's landing where -->
            <ul class="mt-2 max-h-28 space-y-1 overflow-auto">
                <li v-for="group in groups" :key="group.name" class="flex items-center gap-2 text-2xs">
                    <Icon name="folder" class="text-[0.6rem] text-muted" />
                    <span class="flex-1 truncate">{{ group.name === `` ? t(`workspace.uploadProgressBody.workspaceRoot`) : group.name }}</span>
                    <span :class="group.failed > 0 ? `text-danger` : `text-subtle`">{{ group.done }}/{{ group.total }}</span>
                </li>
            </ul>

            <!-- Failures spelled out, the first of them by name. This is the one phase that never retires itself. -->
            <ul v-if="failures.length > 0" class="mt-3 max-h-24 space-y-1 overflow-auto">
                <li v-for="file in failures" :key="file.path" class="text-2xs text-danger" v-tooltip.left="file.error">
                    <span class="truncate">{{ file.path }}</span>
                    <span class="text-subtle">: {{ file.error }}</span>
                </li>
                <li v-if="failedCount > failures.length" class="text-2xs text-subtle">
                    {{ t(`workspace.uploadProgressBody.moreFailures`, { count: failedCount - failures.length }) }}
                </li>
            </ul>
            <p v-if="unreadableCount > 0" class="mt-2 text-2xs text-danger">
                {{ t(`workspace.uploadProgressBody.unreadableLeftOut`, { count: unreadableCount }, unreadableCount) }}
            </p>
        </template>

        <!-- Dependencies remain visible through scan, upload, and outcome phases. -->
        <div v-if="setupSummary.length > 0" class="mt-3">
            <!-- Still uploading: the offer is pre-checked; unchecking becomes the remembered default. -->
            <template v-if="!finished">
                <label class="flex cursor-pointer items-center gap-2">
                    <Checkbox
                        :model-value="installAfterUpload"
                        binary
                        size="small"
                        @update:model-value="setInstallAfterUpload($event as boolean)"
                        input-id="install-after-upload"
                    />
                    <span class="flex-1 font-medium">{{ t(`workspace.uploadProgressBody.installDependenciesAfterUpload`) }}</span>
                </label>
                <ul class="mt-1 space-y-0.5">
                    <li v-for="project in setupSummary" :key="project.dir" class="flex items-center gap-2 text-2xs text-subtle">
                        <span class="truncate">{{ project.dir }}</span>
                        <span class="shrink-0">{{ project.label }}</span>
                    </li>
                </ul>
            </template>

            <!-- Couldn't even ask the daemon; the upload still succeeded, so this is a note, not a failure. -->
            <div v-else-if="installError !== undefined" class="flex items-start gap-2 text-2xs text-danger">
                <Icon name="exclamation-triangle" class="mt-0.5 text-sm" />
                <span class="flex-1">{{ installError }}</span>
            </div>

            <div v-else-if="!installSettled" class="flex items-center gap-2">
                <Icon name="spinner" class="text-sm text-muted" spin />
                <span class="flex-1 font-medium">{{ t(`workspace.uploadProgressBody.startingInstall`) }}</span>
            </div>

            <!-- Queued through the workspace lease; may start immediately, or after active turns drain. -->
            <template v-else-if="installQueued.length > 0">
                <div class="flex items-center gap-2">
                    <Icon name="clock" class="text-sm text-muted" />
                    <span class="flex-1 font-medium">{{ t(`workspace.uploadProgressBody.dependencyInstallQueued`) }}</span>
                </div>
                <p class="mt-0.5 text-2xs text-subtle">
                    {{ t(`workspace.uploadProgressBody.startsAfterActiveAgent`) }}
                </p>
            </template>

            <!-- No-installable state stays neutral when nothing changed. -->
            <div v-else-if="installAfterUpload" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="info-circle" class="text-sm text-muted" />
                <span class="flex-1">{{ t(`workspace.uploadProgressBody.noDependencyInstallQueued`) }}</span>
            </div>
        </div>
    </div>
</template>
