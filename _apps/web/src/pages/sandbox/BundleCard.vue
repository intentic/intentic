<script setup lang="ts">
import { ImportReportSchema, type ImportReport } from "@intentic-app/api-contract";
import { Card, StatusBadge } from "@intentic-app/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { sandboxJson, sandboxRequest } from "../../composables/sandbox/sandboxClient";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useAsyncAction } from "../../composables/useAsyncAction";

/* MOVING A SANDBOX — export this one's environment as a file, or restore one into this sandbox.
 *
 * The two volumes that hold an environment (`/work` and the daemon's `/history`) travel; the CONTAINER cannot.
 * That asymmetry is the whole reason this card ends in a report rather than a success tick: the image the
 * overlay describes is built by the machine running the container, so a restored sandbox is complete only once
 * its owner runs the rebuild the Environment card above then shows.
 *
 * The secrets switch is a real decision, not a preference, so it is presented as one — off by default (the
 * bundle is safe to send someone), and the warning under it says what turning it on puts in the file.
 */

const isOwner = computed(() => useSandbox().active.value?.role === `owner`);

const withSecrets = ref(false);
const report = ref<ImportReport | undefined>(undefined);
const { busy: exporting, error: exportError, run: runExport } = useAsyncAction();
const { busy: importing, error: importError, run: runImport } = useAsyncAction();

/* The download goes through fetch rather than a plain link because every daemon call carries a bearer, and an
 * <a href> cannot. The response is materialized as a Blob — the browser holds it before it hits disk, which is
 * the one place this card trades simplicity for ceiling. It is bounded in practice by what the bundle leaves
 * out (node_modules, build output, the iq index, agent checkouts) rather than by the workspace's size.
 * ponytail: stream straight to disk via showSaveFilePicker where the browser has it, and keep this as the fallback.
 */
const exportBundle = (): Promise<void> =>
    runExport(async () => {
        const response = await sandboxRequest(`/bundle${withSecrets.value ? `?secrets=1` : ``}`);
        if (!response.ok) {
            throw new Error(response.status === 403 ? `Only the sandbox owner can export the environment.` : `The export failed.`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement(`a`);
        anchor.href = url;
        // The daemon's Content-Disposition names it; this is the fallback for browsers that ignore it on a blob URL.
        anchor.download = /filename="([^"]+)"/.exec(response.headers.get(`content-disposition`) ?? ``)?.[1] ?? `intentic-bundle.tar.gz`;
        anchor.click();
        URL.revokeObjectURL(url);
    }, `Could not export the environment.`);

const chooseBundle = ref<HTMLInputElement>();
const importBundle = (event: Event): Promise<void> =>
    runImport(async () => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file === undefined) {
            return;
        }
        report.value = undefined;
        // One continuous body, like the folder-drop archive route — the daemon streams it to disk entry by entry.
        report.value = ImportReportSchema.parse(await sandboxJson(`/bundle`, { method: `POST`, body: file, duplex: `half` } as RequestInit));
    }, `Could not restore the bundle.`);
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
                        The downloaded file will contain credentials in the clear. Store it like a password.
                    </p>
                </div>
                <ToggleSwitch v-model="withSecrets" class="mt-0.5 shrink-0" />
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <Button label="Export environment" size="small" :loading="exporting" @click="exportBundle">
                    <template #icon><Icon name="download" /></template>
                </Button>
                <Button label="Restore from a bundle" size="small" severity="secondary" :loading="importing" @click="chooseBundle?.click()">
                    <template #icon><Icon name="upload" /></template>
                </Button>
                <input ref="chooseBundle" type="file" accept=".gz,.tgz,application/gzip" class="hidden" @change="importBundle" />
            </div>
            <p class="text-2xs text-subtle">
                Restore onto a FRESH sandbox. It overwrites files this workspace already has, and any agent working here would be writing underneath
                it.
            </p>
        </template>
        <p v-else class="text-2xs text-subtle">Only the sandbox owner can export or restore an environment.</p>

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

        <p v-if="exportError" class="text-2xs text-danger">{{ exportError }}</p>
        <p v-if="importError" class="text-2xs text-danger">{{ importError }}</p>
    </Card>
</template>
