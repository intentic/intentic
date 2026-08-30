<script setup lang="ts">
import { formatBytes } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed, onBeforeUnmount, watch } from "vue";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";

/* THE DETAIL UNDER AN IMPORT'S HEADLINE: the bar, the per-folder breakdown, the failures, the dependency offer.
 *
 * Which PHASE the import is in, and the one sentence naming it, are the notification's
 * (composables/notificationSources.ts). What is here is everything that phase needs to show and cannot say in a
 * string. That split is why this stopped being a panel that drew its own box in the bottom-right corner: it was
 * the third component to claim that corner, drawn under the other two by nothing more principled than its
 * z-index. Now it is one card in one lane, and the lane draws the box, the icon and the dismiss.
 *
 * THE RETIREMENT TIMERS STAY HERE, with the thing they are about. They are the queue's own etiquette rather than
 * the lane's: a clean finish says so and goes, and a finish that started an install stays longer, because that
 * line is news rather than an acknowledgement. A failure does not retire at all — it is the only state here the
 * user might have to act on, and it waits for them. */

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

// Shown for every phase that has bytes in flight or bytes that failed. A clean finish does not: its headline
// already says the whole truth, and a full bar under "Uploaded 12 files" is a progress indicator for something
// with no progress left to make.
const breakdown = computed(() => files.value.length > 0 && !(finished.value && failedCount.value === 0));

// One row per top-level dropped folder (root-level loose files group under "(files)"): scales to huge drops
// where a flat per-file list would not.
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

// A drop omits node_modules/.venv, so the project lands unusable until its dependencies are installed. The
// offer is shown for the WHOLE upload rather than as a dialog before it or a prompt after: the user keeps the
// "drag it in and it just works" flow, and still has the entire upload to uncheck it before anything runs.
// One line per project, since a drop can carry several; `evidence` names the file we read so the pick is
// never opaque ("pnpm · pnpm-lock.yaml", or "npm · package.json (no lockfile)", which invites a correction).
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
        // Hold the card until the install request has settled, so a clean finish can't vanish before saying
        // what it kicked off. Longer once something started: that line is news, not just an acknowledgement.
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
        <!-- Still walking the dropped tree while files are already going up: the headline belongs to the upload
             by then, so the scan reports itself here instead. -->
        <p v-if="scanning && files.length > 0" class="mb-2 truncate border-b border-line pb-2 text-2xs text-subtle">
            Scanning… {{ scannedCount }} {{ scannedCount === 1 ? `file` : `files`
            }}<template v-if="scanningName !== ``"> · {{ scanningName }}</template>
        </p>
        <!-- Nothing sent yet: the headline carries the count, so all this adds is where the walk has got to. -->
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

        <!-- Dependencies. Outside the branches above so it rides every phase of the import: the offer during
             scan + upload, the outcome after. Hidden entirely when the drop carries no project. -->
        <div v-if="setupSummary.length > 0" class="mt-3">
            <!-- Still uploading: the offer, pre-checked. Unchecking is remembered as the default for next time. -->
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

            <!-- Couldn't even ask the daemon. The upload still succeeded, so this is a note, not a failure. -->
            <div v-else-if="installError !== undefined" class="flex items-start gap-2 text-2xs text-danger">
                <Icon name="exclamation-triangle" class="mt-0.5 text-sm" />
                <span class="flex-1">{{ installError }}</span>
            </div>

            <div v-else-if="!installSettled" class="flex items-center gap-2">
                <Icon name="spinner" class="text-sm text-muted" spin />
                <span class="flex-1 font-medium">Starting install…</span>
            </div>

            <!-- Queued through the workspace lease. It may start immediately, or after active turns drain. -->
            <template v-else-if="installQueued.length > 0">
                <div class="flex items-center gap-2">
                    <Icon name="clock" class="text-sm text-muted" />
                    <span class="flex-1 font-medium">Dependency install queued</span>
                </div>
                <p class="mt-0.5 text-2xs text-subtle">
                    It starts after active agent turns finish, then appears in Work terminals; checks and the outcome appear in Activity.
                </p>
            </template>

            <!-- Asked, but no project was installable: usually already ready, possibly unsupported. Keep the
                 answer neutral rather than claiming success the daemon did not report. -->
            <div v-else-if="installAfterUpload" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="info-circle" class="text-sm text-muted" />
                <span class="flex-1">No dependency install queued</span>
            </div>
        </div>
    </div>
</template>
