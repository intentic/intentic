<script setup lang="ts">
import Checkbox from "primevue/checkbox";
import { computed, onBeforeUnmount, watch } from "vue";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { formatBytes } from "@intentic-app/ui";

// Non-blocking upload feedback, anchored bottom-right of the workspace body. Driven entirely by useUploadQueue —
// the drop targets and the upload button all funnel through it, so a second drop mid-upload just appends here.
// Narrates the whole lifecycle from the first interaction: Scanning the dropped folder → Uploading (aggregate
// bytes + throughput + per-folder breakdown) → Done. Auto-dismisses on a clean finish; stays (with the failures
// listed) when something fails.
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
    skippedUnchanged,
    failedCount,
    doneCount,
    throughput,
    setupProjects,
    installAfterUpload,
    setInstallAfterUpload,
    installStarted,
    installError,
    installSettled,
    dismiss,
} = useUploadQueue();

const pct = computed(() => (bytesTotal.value === 0 ? 100 : Math.min(100, Math.round((bytesDone.value / bytesTotal.value) * 100))));

// One row per top-level dropped folder (root-level loose files group under "(files)") — scales to huge drops
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
// never opaque ("pnpm — pnpm-lock.yaml", or "npm — package.json (no lockfile)", which invites a correction).
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
        // Hold the panel until the install request has settled, so a clean finish can't vanish before saying
        // what it kicked off. Longer once something started — that line is news, not just an acknowledgement.
        if (isFinished && failedCount.value === 0 && isSettled && installError.value === undefined) {
            timer = setTimeout(dismiss, installStarted.value.length > 0 ? 6000 : 3000);
        }
    },
    { immediate: true },
);
// A "nothing to upload" notice is informational — auto-dismiss it like a clean finish.
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
    <div class="absolute bottom-3 right-3 z-30 w-80 rounded-md border border-line bg-card px-3 py-2 text-xs text-content shadow-lg">
        <!-- Scanning phase: walking the dropped folder tree, before any upload can start -->
        <div v-if="scanning" :class="files.length > 0 ? `mb-2 border-b border-line pb-2` : ``">
            <div class="flex items-center gap-2">
                <Icon name="spinner" class="text-sm text-muted" spin />
                <span class="flex-1 font-medium">Scanning dropped folder… {{ scannedCount }} {{ scannedCount === 1 ? `file` : `files` }}</span>
                <button
                    type="button"
                    class="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click="dismiss"
                    aria-label="Cancel"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>
            <p v-if="scanningName !== ``" class="mt-0.5 truncate text-2xs text-subtle">{{ scanningName }}</p>
        </div>

        <!-- Nothing to upload: only symlinks/special items (which Chrome won't expose) or an empty folder -->
        <div v-if="skippedNotice !== undefined && files.length === 0" class="flex items-center gap-2">
            <Icon name="info-circle" class="text-sm text-muted" />
            <span class="flex-1 font-medium">
                Nothing to upload<template v-if="skippedNotice > 0">
                    — skipped {{ skippedNotice }} {{ skippedNotice === 1 ? `item` : `items` }} that couldn't be read (symlink or special
                    file)</template
                >
            </span>
            <button
                type="button"
                class="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="dismiss"
                aria-label="Dismiss"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>

        <!-- Re-drop where every file was already identical on the sandbox (nothing to send) -->
        <div v-if="files.length === 0 && skippedNotice === undefined && skippedUnchanged > 0" class="flex items-center gap-2">
            <Icon name="check-circle" class="text-sm text-success" />
            <span class="flex-1 font-medium"
                >Already up to date — skipped {{ skippedUnchanged }} unchanged {{ skippedUnchanged === 1 ? `file` : `files` }}</span
            >
            <button
                type="button"
                class="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="dismiss"
                aria-label="Dismiss"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>

        <!-- Done, all succeeded -->
        <template v-if="files.length === 0"></template>
        <template v-else-if="finished && failedCount === 0">
            <div class="flex items-center gap-2">
                <Icon name="check-circle" class="text-sm text-success" />
                <span class="font-medium">Uploaded {{ files.length }} {{ files.length === 1 ? `file` : `files` }}</span>
            </div>
        </template>

        <!-- Uploading, or done with failures — both show the breakdown -->
        <template v-else>
            <div class="flex items-center gap-2">
                <Icon name="spinner" v-if="!finished" class="text-sm text-muted" spin />
                <Icon name="exclamation-triangle" v-else class="text-sm text-danger" />
                <span class="flex-1 font-medium">
                    <template v-if="!finished">Uploading {{ doneCount }} of {{ files.length }}</template>
                    <template v-else>Uploaded {{ doneCount }} of {{ files.length }} · {{ failedCount }} failed</template>
                    <template v-if="skippedUnchanged > 0"> · skipped {{ skippedUnchanged }} unchanged</template>
                </span>
                <button
                    type="button"
                    class="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click="dismiss"
                    :aria-label="finished ? `Dismiss` : `Cancel`"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>

            <div class="mt-2 h-1 overflow-hidden rounded bg-overlay">
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

            <!-- Failures spelled out (stays until dismissed) -->
            <ul v-if="failures.length > 0" class="scrollbar-thin mt-2 max-h-24 space-y-1 overflow-auto border-t border-line pt-2">
                <li v-for="file in failures" :key="file.path" class="text-2xs text-danger" v-tooltip.left="file.error">
                    <span class="truncate">{{ file.path }}</span>
                    <span class="text-subtle"> — {{ file.error }}</span>
                </li>
            </ul>
        </template>

        <!-- Dependencies. Outside the branches above so it rides every phase of the import: the offer during
             scan + upload, the outcome after. Hidden entirely when the drop carries no project. -->
        <div v-if="setupSummary.length > 0" class="mt-2 border-t border-line pt-2">
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

            <!-- Running. The tmux panel owns the real output, so point there rather than mirroring it here. -->
            <template v-else-if="installStarted.length > 0">
                <div class="flex items-center gap-2">
                    <Icon name="spinner" class="text-sm text-muted" spin />
                    <span class="flex-1 font-medium">Installing dependencies…</span>
                </div>
                <p class="mt-0.5 text-2xs text-subtle">Running in the terminal panel — you can watch, cancel or re-run it there.</p>
            </template>

            <!-- Asked, nothing to do: the daemon found every project already installed. Said out loud because
                 silence here reads as "it ignored me", which is what sends people to re-drop the folder. -->
            <div v-else-if="installAfterUpload" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="check-circle" class="text-sm text-success" />
                <span class="flex-1">Dependencies already installed</span>
            </div>
        </div>
    </div>
</template>
