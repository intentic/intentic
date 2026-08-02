<script setup lang="ts">
import { ImportReportSchema, type BundleExport, type ImportReport } from "@intentic-app/api-contract";
import { Card, formatDateTime, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { bundleDownloadUrl, useBundleExports } from "../../composables/sandbox/useBundleExports";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useAsyncAction } from "../../composables/useAsyncAction";

/* MOVING A SANDBOX — export this one's environment to a file, or restore one into this sandbox.
 *
 * Everything on the left of this card is DERIVED from the daemon's export directory (useBundleExports), which
 * is what makes an export findable later. The first cut streamed the bundle down the click's own response and
 * held its state in a local `busy` ref: switching view or refreshing abandoned the pack AND lost every trace of
 * it, leaving a reset button and no answer to "where did my export go". Now the click starts a job, the row
 * appears at once, and the row is still there — packing, ready or failed — however the browser is treated in
 * the minutes that follow.
 *
 * The container still cannot travel, which is why a restore ends in a report rather than a success tick: the
 * image the overlay describes is built by the machine running the container.
 */

const isOwner = computed(() => useSandbox().active.value?.role === `owner`);
const { exports, packing, start, remove, error: listError } = useBundleExports();

const withSecrets = ref(false);
const report = ref<ImportReport | undefined>(undefined);
const { busy: starting, error: startError, run: runStart } = useAsyncAction();
const { busy: importing, error: importError, run: runImport } = useAsyncAction();

const startExport = (): Promise<void> => runStart(() => start(withSecrets.value), `Could not start the export.`);

/* Navigating to the URL is the point: the browser's own download manager takes the file, with a real
 * Content-Length behind it, so a multi-GB bundle never passes through this tab's memory — and closing the tab
 * afterwards does not cancel it. */
const download = (entry: BundleExport): Promise<void> =>
    runStart(async () => {
        window.location.href = await bundleDownloadUrl(entry.name);
    }, `Could not start the download.`);

const chooseBundle = ref<HTMLInputElement>();
const importBundle = (event: Event): Promise<void> =>
    runImport(async () => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file === undefined) {
            return;
        }
        report.value = undefined;
        // One continuous body, like the folder-drop archive route — the daemon streams it to disk entry by entry.
        report.value = ImportReportSchema.parse(await sandboxJson(`/bundles/restore`, { method: `POST`, body: file, duplex: `half` } as RequestInit));
    }, `Could not restore the bundle.`);

const sizeLabel = (bytes: number): string => {
    const units = [`B`, `KB`, `MB`, `GB`];
    const index = Math.min(units.length - 1, bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};
</script>

<template>
    <Card class="flex flex-col gap-4">
        <div class="flex items-center gap-2.5">
            <Icon name="box" class="text-lg text-muted" />
            <div>
                <h2 class="font-semibold leading-tight">Move this sandbox</h2>
                <p class="text-2xs text-subtle">
                    Export the workspace, its git history and the agent board as one file — then restore it into a fresh sandbox.
                </p>
            </div>
        </div>

        <template v-if="isOwner">
            <div class="flex items-start justify-between gap-4 rounded-lg border border-line p-3">
                <div>
                    <p class="text-xs font-medium text-content">Include secrets</p>
                    <p class="text-2xs text-subtle">
                        Capability credentials, the CI webhook secret, extension settings, ssh keys and the agent's AI logins. Leave this off and the
                        bundle is safe to hand to someone else — the restore then lists what to re-enter.
                    </p>
                    <p v-if="withSecrets" class="mt-1 text-2xs text-warning">
                        The exported file will contain credentials in the clear. Store it like a password.
                    </p>
                </div>
                <ToggleSwitch v-model="withSecrets" :disabled="packing !== undefined" class="mt-0.5 shrink-0" />
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <!-- Disabled while one is packing rather than queueing a second: two concurrent packs would
                     halve each other's speed to produce near-identical files, and the daemon 409s anyway. -->
                <Button
                    :label="packing ? 'Export running…' : 'Export environment'"
                    size="small"
                    :loading="starting"
                    :disabled="packing !== undefined"
                    @click="startExport"
                >
                    <template #icon><Icon name="box" /></template>
                </Button>
                <Button label="Restore from a bundle" size="small" severity="secondary" :loading="importing" @click="chooseBundle?.click()">
                    <template #icon><Icon name="upload" /></template>
                </Button>
                <input ref="chooseBundle" type="file" accept=".gz,.tgz,application/gzip" class="hidden" @change="importBundle" />
            </div>
        </template>
        <p v-else class="text-2xs text-subtle">Only the sandbox owner can export or restore an environment.</p>

        <!-- THE ANSWER TO "where do I get it later": the exports that exist, whatever this tab has been doing. -->
        <div v-if="exports.length > 0" class="flex flex-col divide-y divide-line rounded-lg border border-line">
            <div v-for="entry in exports" :key="entry.name" class="flex items-center gap-3 p-3">
                <div class="min-w-0 flex-1">
                    <p class="truncate font-mono text-2xs text-content">{{ entry.name }}</p>
                    <p class="text-2xs text-subtle">
                        <template v-if="entry.status === 'packing'">Packing… {{ sizeLabel(entry.bytes) }} so far</template>
                        <template v-else-if="entry.status === 'failed'">{{ entry.error ?? `The export failed.` }}</template>
                        <template v-else>{{ sizeLabel(entry.bytes) }} · {{ formatDateTime(entry.createdAt) }}</template>
                    </p>
                </div>
                <StatusBadge v-if="entry.secrets && entry.status === 'ready'" variant="warning" label="Secrets" />
                <StatusBadge v-if="entry.status === 'packing'" variant="info" label="Packing" dot />
                <StatusBadge v-else-if="entry.status === 'failed'" variant="danger" label="Failed" dot />
                <Button v-if="entry.status === 'ready'" label="Download" size="small" severity="secondary" :text="true" @click="download(entry)">
                    <template #icon><Icon name="download" /></template>
                </Button>
                <Button
                    v-if="isOwner && entry.status !== 'packing'"
                    size="small"
                    severity="danger"
                    :text="true"
                    aria-label="Delete export"
                    v-tooltip.top="'Delete this export'"
                    @click="remove(entry.name)"
                >
                    <template #icon><Icon name="trash" /></template>
                </Button>
            </div>
        </div>

        <p v-if="isOwner" class="text-2xs text-subtle">
            Exports stay on the sandbox until you delete them, so you can come back for one later. Restore onto a FRESH sandbox — it overwrites files
            this workspace already has.
        </p>

        <!-- The fidelity report: what landed, and what the target cannot do for itself. -->
        <template v-if="report">
            <div class="flex items-center gap-2">
                <StatusBadge variant="success" label="Restored" dot />
                <p class="text-2xs text-subtle">
                    {{ report.restored.workspaceFiles }} workspace files, {{ report.restored.historyFiles }} history files,
                    {{ report.restored.repos.length }} repos ({{ report.restored.repos.join(`, `) }}).
                </p>
            </div>
            <div v-if="report.needsAction.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p class="text-xs font-medium text-content">Finish the move</p>
                <div v-for="action in report.needsAction" :key="action.subject" class="text-2xs">
                    <p class="font-medium text-content">{{ action.subject }}</p>
                    <p class="text-subtle">{{ action.detail }}</p>
                </div>
            </div>
            <p v-if="report.refused.length > 0" class="text-2xs text-warning">
                {{ report.refused.length }} entries were refused — the bundle carried paths this sandbox does not accept (identity files, or paths
                outside the workspace).
            </p>
        </template>

        <p v-if="startError" class="text-2xs text-danger">{{ startError }}</p>
        <p v-if="importError" class="text-2xs text-danger">{{ importError }}</p>
        <p v-if="listError" class="text-2xs text-danger">{{ listError }}</p>
    </Card>
</template>
