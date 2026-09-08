<script setup lang="ts">
import { formatBytes } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed, onBeforeUnmount, watch } from "vue";
import { useUploadQueue } from "./useUploadQueue";

// Detail under an import's headline: progress bar, per-folder breakdown, failures, dependency offer. Phase and its
// headline sentence live in notificationSources.ts; retirement timers live here: a clean finish dismisses quickly, one
// that started an install stays longer, a failure never retires.

const {
    files,
    bytesDone,
    bytesTotal,
    currentName,
    finished,
    scanning,
    scannedCount,
    scanningName,
    skippedNotice,
    failedCount,
    doneCount,
    throughput,
    setupProjects,
    installAfterUpload,
    setInstallAfterUpload,
    installQueued,
    installError,
    installSettled,
    dismiss,
} = useUploadQueue();

const pct = computed(() => (bytesTotal.value === 0 ? 100 : Math.min(100, Math.round((bytesDone.value / bytesTotal.value) * 100))));

// Shown while bytes are in flight or failed; a clean finish's headline already says it all.
const breakdown = computed(() => files.value.length > 0 && !(finished.value && failedCount.value === 0));

// One row per top-level dropped folder (loose root files group under "(files)"): scales where a flat per-file list
// would not.
const groups = computed(() => {
    const map = new Map<string, { name: string; total: number; done: number; failed: number }>();
    for (const file of files.value) {
        const slash = file.path.indexOf(`/`);
        const key = slash === -1 ? `` : file.path.slice(0, slash);
        const group = map.get(key) ?? { name: key === `` ? `(files)` : key, total: 0, done: 0, failed: 0 };
        group.total += 1;
        if (file.status === `done`) {
            group.done += 1;
        }
        if (file.status === `failed`) {
            group.failed += 1;
        }
        map.set(key, group);
    }
    return Array.from(map.values());
});
const failures = computed(() => files.value.filter((file) => file.status === `failed`));

// Offer shown for the whole upload (not a dialog or prompt), so drag-and-drop still just works, with time to uncheck
// it. One row per project; label names the file read (e.g. "pnpm · pnpm-lock.yaml") so the pick isn't opaque.
const setupSummary = computed(() =>
    setupProjects.value.map((project) => ({
        dir: project.dir === `` ? `the workspace root` : project.dir,
        label: `${project.recipe.manager} · ${project.recipe.evidence}`,
    })),
);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(
    [finished, installSettled],
    ([isFinished, isSettled]) => {
        // Holds until install settles, so a clean finish can't vanish before saying what it kicked off.
        if (isFinished && failedCount.value === 0 && isSettled && installError.value === undefined) {
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
    <div class="text-xs text-content">
        <!-- Still scanning while files are already uploading; the headline belongs to the upload by then. -->
        <p v-if="scanning && files.length > 0" class="mb-2 truncate border-b border-line pb-2 text-2xs text-subtle">
            Scanning… {{ scannedCount }} {{ scannedCount === 1 ? `file` : `files`
            }}<template v-if="scanningName !== ``"> · {{ scanningName }}</template>
        </p>
        <!-- Nothing sent yet: the headline already carries the count; this just says where the walk has got to. -->
        <p v-else-if="scanning && scanningName !== ``" class="truncate text-2xs text-subtle">{{ scanningName }}</p>

        <template v-if="breakdown">
            <div class="h-1 overflow-hidden rounded bg-overlay">
                <div class="h-full rounded bg-primary-500 transition-[width] duration-200" :style="{ width: `${pct}%` }"></div>
            </div>
            <div class="mt-1 flex items-center justify-between text-2xs text-subtle">
                <span>{{ formatBytes(bytesDone) }} / {{ formatBytes(bytesTotal) }}</span>
                <span v-if="!finished">{{ formatBytes(throughput) }}/s</span>
            </div>
            <p v-if="!finished && currentName !== ``" class="mt-0.5 truncate text-2xs text-subtle">{{ currentName }}</p>

            <!-- Per-folder breakdown: what's landing where -->
            <ul class="scrollbar-thin mt-2 max-h-28 space-y-1 overflow-auto">
                <li v-for="group in groups" :key="group.name" class="flex items-center gap-2 text-2xs">
                    <Icon name="folder" class="text-[0.6rem] text-muted" />
                    <span class="flex-1 truncate">{{ group.name }}</span>
                    <span :class="group.failed > 0 ? `text-danger` : `text-subtle`">{{ group.done }}/{{ group.total }}</span>
                </li>
            </ul>

            <!-- Failures spelled out. This is the one phase that never retires itself. -->
            <ul v-if="failures.length > 0" class="scrollbar-thin mt-3 max-h-24 space-y-1 overflow-auto">
                <li v-for="file in failures" :key="file.path" class="text-2xs text-danger" v-tooltip.left="file.error">
                    <span class="truncate">{{ file.path }}</span>
                    <span class="text-subtle">: {{ file.error }}</span>
                </li>
            </ul>
        </template>

        <!-- Dependencies section rides every phase (offer during scan/upload, outcome after); hidden entirely when the drop has no project. -->
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
                    <span class="flex-1 font-medium">Install dependencies after upload</span>
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
                <span class="flex-1 font-medium">Starting install…</span>
            </div>

            <!-- Queued through the workspace lease; may start immediately, or after active turns drain. -->
            <template v-else-if="installQueued.length > 0">
                <div class="flex items-center gap-2">
                    <Icon name="clock" class="text-sm text-muted" />
                    <span class="flex-1 font-medium">Dependency install queued</span>
                </div>
                <p class="mt-0.5 text-2xs text-subtle">
                    It starts after active agent turns finish, then appears in Work terminals; checks and the outcome appear in Activity.
                </p>
            </template>

            <!--
                Asked, but nothing was installable (already ready, or unsupported); stays neutral rather than claiming a success the daemon didn't
                report.
            -->
            <div v-else-if="installAfterUpload" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="info-circle" class="text-sm text-muted" />
                <span class="flex-1">No dependency install queued</span>
            </div>
        </div>
    </div>
</template>
