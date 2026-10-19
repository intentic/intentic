<script setup lang="ts">
import type { BundleExport } from "@intentic/sandbox-contract/schemas/environment";
import type { DefinitionDiff, DefinitionExport, WorkspaceRemote } from "@intentic/sandbox-contract/state/definition";
import {
    Button,
    CopyButton,
    formatBytes,
    formatDateTime,
    type NoticeModel,
    NoticeStack,
    Row,
    RowGroup,
    StatusBadge,
    ui,
    vAction,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { bundleDownloadUrl, useBundleExports } from "./useBundleExports";
import ExportBundleDialog from "./ExportBundleDialog.vue";
import { workspaceRepoOf } from "../overview/workspaceRepo";
import { PUBLISH_ANCHOR } from "./publishAnchor";
import { useOperation } from "../../../workbench/operations/operations";
import { useT } from "@intentic/ui/i18n";
import WaitProgress from "../../../components/WaitProgress.vue";
import { useWaitClock } from "../../../components/useWaitClock";

// Body of <ExportCard>: everything that leaves this sandbox, at three fidelities (published workspace,
// sandbox.toml document, bundle), in that order since publishing unlocks what a definition can carry and comparing
// writes nothing. Card chrome and the role check belong to <ExportCard>, not here.

// The workspace repo, the half a definition cannot supply for itself.
const t = useT();

const workspace = ref<WorkspaceRemote | undefined>(undefined);
const confirmingPublish = ref(false);
// Why the repo could not be read: a read on opening, not something the reader started, so it stays with the panel.
const workspaceError = ref<NoticeModel | undefined>(undefined);
// Publishing creates a repository and pushes the whole workspace, so it is the sandbox's run, not the panel's: the
// panel opened again mid-push holds the button, and then shows where it went.
const publishOp = useOperation<WorkspaceRemote>(`access/move-out/publish`);
const publishing = publishOp.busy;
const publishError = publishOp.failure;
// How long the push has run, under its row: a whole workspace takes from seconds to minutes, and the panel opened again
// mid-push has no confirm step left to explain the held button.
const publishWait = useWaitClock(() => (publishing.value ? publishOp.operation.value?.startedAt : undefined));

// Read up front, not behind a button: publish status decides if a downloaded definition carries real content.
const published = computed(() => (workspace.value?.remote === undefined ? undefined : workspaceRepoOf(workspace.value.remote)));
const host = computed(() => workspace.value?.hosts[0]);

const loadWorkspace = async (): Promise<void> => {
    workspaceError.value = undefined;
    try {
        workspace.value = await sandboxRaw(`GET /definition/workspace`);
    } catch (error) {
        workspaceError.value = noticeFrom(error, t(`sandbox.moveOutPanel.couldntReadWorkspaceRepo`));
    }
};

onMounted(() => {
    void loadWorkspace();
});

// A publish that lands is the repo as it now stands, whichever mount of the panel is up when it does.
watch(
    () => publishOp.value.value,
    (result) => {
        if (result !== undefined) {
            workspace.value = { remote: result.remote, branch: result.branch, hosts: workspace.value?.hosts ?? [] };
        }
    },
    { immediate: true },
);

// Confirmed, not one-click: publishing creates a repository on someone's account and pushes to it.
const publish = async (): Promise<void> => {
    if (publishing.value) {
        return;
    }
    const hosts = workspace.value?.hosts ?? [];
    const outcome = await publishOp.run({
        what: t(`sandbox.moveOutPanel.publishingWorkspace`),
        failed: t(`sandbox.moveOutPanel.couldntPublishWorkspace`),
        task: async () => {
            const result = await sandboxRaw(`POST /definition/workspace/publish`, { input: {} });
            return { remote: result.remote, branch: result.branch, hosts };
        },
    });
    if (outcome?.state === `done`) {
        confirmingPublish.value = false;
    }
};

// The document. Small text, so unlike a bundle it downloads through an object URL rather than a ticket; the run hands
// the download to the browser whether or not the panel is still open, and what it left out is shown beside it.
const deriveOp = useOperation<DefinitionExport>(`access/move-out/definition`);
const deriving = deriveOp.busy;
const deriveError = deriveOp.failure;
const derived = deriveOp.value;
const downloadDefinition = async (): Promise<void> => {
    await deriveOp.run({
        what: t(`sandbox.moveOutPanel.downloadSandboxToml`),
        failed: t(`sandbox.moveOutPanel.couldntDeriveDefinition`),
        quiet: true,
        task: async () => {
            const answer = await sandboxRaw(`GET /definition`);
            const url = URL.createObjectURL(new Blob([answer.toml], { type: `application/toml` }));
            const anchor = document.createElement(`a`);
            anchor.href = url;
            anchor.download = `sandbox.toml`;
            anchor.click();
            URL.revokeObjectURL(url);
            return answer;
        },
    });
};

// The bundle
// Export state derives from the export directory (useBundleExports), surviving a refresh or view switch.
const { exports, packing, start, remove, error: listError } = useBundleExports();
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined
        ? undefined
        : { tone: `danger`, title: t(`sandbox.moveOutPanel.couldntListSandboxsBundles`), detail: listError.value },
);

// Starting an export, and asking for a download ticket, are each a quick ask whose end shows in the list the export
// directory backs (useBundleExports); one run between them, as before, so a refusal is kept for the panel opened again.
const startOp = useOperation(`access/move-out/export`);
const starting = startOp.busy;
const startError = startOp.failure;

// Panel holds only whether the dialog is open; the answer belongs to <ExportBundleDialog>. Closed on the start landing,
// so a failed start leaves the dialog up with the notice, not a reset button.
const exporting = ref(false);
const startExport = async (secrets: boolean): Promise<void> => {
    const outcome = await startOp.run({
        what: t(`sandbox.moveOutPanel.exportRunning`),
        failed: t(`sandbox.moveOutPanel.couldntStartExport`),
        quiet: true,
        task: () => start(secrets),
    });
    if (outcome?.state === `done`) {
        exporting.value = false;
    }
};

// Navigates to the URL so the browser's own download manager takes over; a multi-GB bundle never passes through this
// tab's memory, and closing the tab doesn't cancel it.
const download = async (entry: BundleExport): Promise<void> => {
    await startOp.run({
        what: t(`sandbox.moveOutPanel.downloadExport`),
        failed: t(`sandbox.moveOutPanel.couldntStartDownload`),
        quiet: true,
        task: async () => {
            window.location.href = await bundleDownloadUrl(entry.name);
        },
    });
};

// The read. The comparison is of a file the reader picked, which nothing can read back, so the answer is the run's:
// the panel opened again mid-compare finds it still going and then its differences.
const compareOp = useOperation<DefinitionDiff>(`access/move-out/compare`);
const comparing = compareOp.busy;
const diffError = compareOp.failure;
const diff = compareOp.value;
const chooseCompare = ref<HTMLInputElement>();
const compare = async (event: Event): Promise<void> => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ``;
    if (file === undefined || comparing.value) {
        return;
    }
    await compareOp.run({
        what: t(`sandbox.moveOutPanel.compareSandboxToml`),
        failed: t(`sandbox.moveOutPanel.couldntCompareDefinition`),
        quiet: true,
        task: async () => await sandboxRaw(`POST /definition/diff`, { input: await file.text() }),
    });
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- Publishing controls wait until the repository state is known. -->
        <RowGroup v-if="workspace !== undefined" flat>
            <Row v-if="published !== undefined" :icon="published.icon">
                <template #title
                    ><span class="block truncate font-mono text-2xs">{{ published.project }}</span></template
                >
                <template v-if="workspace?.branch !== undefined" #meta>
                    <span class="inline-flex items-center gap-1"><Icon name="fork" />{{ workspace.branch }}</span>
                </template>
                <template #control>
                    <a
                        v-if="published.browseUrl !== undefined"
                        :href="published.browseUrl"
                        target="_blank"
                        rel="noopener"
                        :class="ui.iconButton()"
                        :aria-label="t(`sandbox.moveOutPanel.openWorkspaceRepository`)"
                        v-tooltip.top="t(`sandbox.moveOutPanel.openRepository`)"
                    >
                        <Icon name="external-link" class="text-sm" />
                    </a>
                    <CopyButton
                        :text="workspace?.remote ?? ``"
                        :aria-label="t(`sandbox.moveOutPanel.copyCloneUrl`)"
                        v-tooltip.top="t(`sandbox.moveOutPanel.copyUrl`)"
                    />
                </template>
            </Row>

            <!-- The description is what blocks the button, so a greyed-out control never needs a press to explain itself. -->
            <!-- The anchor "No repository to push this work to" lands on; without an account the way to one is linked here. -->
            <Row v-else :id="PUBLISH_ANCHOR" icon="cloud-upload" :title="t(`sandbox.moveOutPanel.notPublished`)">
                <template #description>
                    <template v-if="host === undefined">
                        {{ t(`sandbox.moveOutPanel.connectGithubGitlabAccount`) }}
                        <RouterLink to="/capabilities/github" :class="ui.textButton()">{{ t(`sandbox.moveOutPanel.connectGithub`) }}</RouterLink>
                    </template>
                    <template v-else>{{ t(`ui.action.publish`) }} <span class="font-mono">/work</span>.</template>
                </template>
                <template #control>
                    <Button
                        v-if="!confirmingPublish"
                        :label="t(`ui.action.publish`)"
                        size="small"
                        tier="boring"
                        :disabled="host === undefined"
                        :loading="publishing"
                        @click="confirmingPublish = true"
                    />
                    <template v-else>
                        <Button :label="t(`ui.action.publish`)" size="small" :loading="publishing" @click="publish" />
                        <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" @click="confirmingPublish = false" />
                    </template>
                </template>
                <!-- Shown only at the confirm moment, not as standing prose; once pressed, how long the push has run. -->
                <template v-if="confirmingPublish || publishWait" #below>
                    <WaitProgress
                        v-if="publishWait"
                        :wait="publishWait"
                        :what="t(`sandbox.moveOutPanel.publishingNote`)"
                        :details="publishOp.lines.value"
                    />
                    <i18n-t v-else keypath="sandbox.moveOutPanel.createsPrivateRepository" tag="p" class="text-2xs text-subtle" scope="global">
                        <template #host>{{ host }}</template>
                        <template #work><span class="font-mono">/work</span></template>
                        <template #env><span class="font-mono">.env</span></template>
                    </i18n-t>
                </template>
            </Row>
        </RowGroup>

        <!-- Publishable and private export choices remain visible together. -->
        <div class="flex flex-wrap items-center gap-2">
            <Button :label="t(`sandbox.moveOutPanel.downloadSandboxToml`)" size="small" :loading="deriving" @click="downloadDefinition">
                <template #icon><Icon name="download" /></template>
            </Button>
            <!-- Disabled while one pack runs; two concurrent packs would only halve each other's speed, and the daemon 409s anyway. -->
            <Button
                :label="packing ? t(`sandbox.moveOutPanel.exportRunning`) : t(`sandbox.moveOutPanel.exportEnvironment`)"
                size="small"
                tier="boring"
                :disabled="packing !== undefined"
                @click="exporting = true"
            >
                <template #icon><Icon name="box" /></template>
            </Button>
            <Button
                :label="t(`sandbox.moveOutPanel.compareSandboxToml`)"
                size="small"
                tier="quiet"
                :loading="comparing"
                @click="chooseCompare?.click()"
            />
            <input ref="chooseCompare" type="file" accept=".toml,text/plain,application/toml" class="hidden" @change="compare" />
        </div>

        <ExportBundleDialog :open="exporting" :busy="starting" @cancel="exporting = false" @confirm="startExport" />

        <!-- What the export could not express, said beside the file it just handed over. -->
        <RowGroup v-if="derived !== undefined && derived.omitted.length > 0" flat :label="t(`sandbox.moveOutPanel.notInDocument`)">
            <Row v-for="entry in derived.omitted" :key="entry.subject" :title="entry.subject" :description="entry.detail" />
        </RowGroup>

        <!-- Download and delete use the same compact icon affordance. -->
        <RowGroup v-if="exports.length > 0" flat :label="t(`sandbox.words.exports`)">
            <Row v-for="entry in exports" :key="entry.name">
                <template #title
                    ><span class="block truncate font-mono text-2xs">{{ entry.name }}</span></template
                >
                <template #description>
                    <template v-if="entry.status === 'packing'">{{
                        t(`sandbox.moveOutPanel.packingFar`, { bytes: formatBytes(entry.bytes) })
                    }}</template>
                    <template v-else-if="entry.status === 'failed'">{{ entry.error ?? t(`sandbox.moveOutPanel.exportFailed`) }}</template>
                    <template v-else>{{ formatBytes(entry.bytes) }} · {{ formatDateTime(entry.createdAt) }}</template>
                </template>
                <template #meta>
                    <StatusBadge v-if="entry.secrets && entry.status === 'ready'" variant="warning" :label="t(`sandbox.moveOutPanel.secrets`)" />
                    <StatusBadge v-if="entry.status === 'packing'" variant="info" :label="t(`sandbox.moveOutPanel.packing`)" dot />
                    <StatusBadge v-else-if="entry.status === 'failed'" variant="danger" :label="t(`sandbox.moveOutPanel.failed`)" dot />
                </template>
                <template #control>
                    <button
                        v-if="entry.status === 'ready'"
                        type="button"
                        :class="ui.iconButton()"
                        :aria-label="t(`sandbox.moveOutPanel.downloadExport`)"
                        v-tooltip.top="t(`ui.action.download`)"
                        v-action="() => download(entry)"
                    >
                        <Icon name="download" class="text-sm" />
                    </button>
                    <button
                        v-if="entry.status !== 'packing'"
                        type="button"
                        :class="ui.iconButton({ tone: `danger` })"
                        :aria-label="t(`sandbox.moveOutPanel.deleteExport`)"
                        v-tooltip.top="t(`ui.action.delete`)"
                        @click="remove(entry.name)"
                    >
                        <Icon name="trash" class="text-sm" />
                    </button>
                </template>
            </Row>
        </RowGroup>

        <!-- Agreement gets a sentence, not an empty box: "no differences" is itself the answer this check exists to give. -->
        <template v-if="diff !== undefined">
            <div v-if="diff.differences.length === 0" class="flex items-center gap-2">
                <StatusBadge variant="success" :label="t(`sandbox.moveOutPanel.inAgreement`)" dot />
            </div>
            <RowGroup v-else flat :label="t(`sandbox.moveOutPanel.differences`)">
                <Row
                    v-for="difference in diff.differences"
                    :key="difference.subject + difference.detail"
                    :title="difference.subject"
                    :description="difference.detail"
                />
            </RowGroup>
        </template>

        <NoticeStack :of="[startError, deriveError, diffError, workspaceError, publishError, listNotice]" />
    </div>
</template>
