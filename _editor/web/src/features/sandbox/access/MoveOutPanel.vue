<script setup lang="ts">
import {
    DefinitionDiffSchema,
    DefinitionExportSchema,
    WorkspacePublishResultSchema,
    WorkspaceRemoteSchema,
    type BundleExport,
    type DefinitionDiff,
    type DefinitionExport,
    type WorkspaceRemote,
} from "@intentic/api-contract";
import { Button, CopyButton, formatDateTime, type NoticeModel, NoticeStack, Row, RowGroup, StatusBadge, ui, vAction } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { bundleDownloadUrl, useBundleExports } from "./useBundleExports";
import ExportBundleDialog from "./ExportBundleDialog.vue";
import { workspaceRepoOf } from "../overview/workspaceRepo";
import { sizeLabel } from "@intentic/base/format";

// Outbound half of <MoveCard>: everything that leaves this sandbox, at three fidelities (published workspace,
// sandbox.toml document, bundle), in that order since publishing unlocks what a definition can carry and comparing
// writes nothing. Card chrome and the role check belong to <MoveCard>, not here.

// The workspace repo, the half a definition cannot supply for itself.
const workspace = ref<WorkspaceRemote | undefined>(undefined);
const confirmingPublish = ref(false);
const { notice: workspaceError, run: runWorkspace } = useAsyncAction();
const { busy: publishing, notice: publishError, run: runPublish } = useAsyncAction();

// Read up front, not behind a button: publish status decides if a downloaded definition carries real content.
const published = computed(() => (workspace.value?.remote === undefined ? undefined : workspaceRepoOf(workspace.value.remote)));
const host = computed(() => workspace.value?.hosts[0]);

const loadWorkspace = (): Promise<void> =>
    runWorkspace(async () => {
        workspace.value = WorkspaceRemoteSchema.parse(await sandboxJson(`/definition/workspace`));
    }, `Could not read the workspace repo.`);

onMounted(() => {
    void loadWorkspace();
});

// Confirmed, not one-click: publishing creates a repository on someone's account and pushes to it.
const publish = (): Promise<void> =>
    runPublish(async () => {
        const result = WorkspacePublishResultSchema.parse(
            await sandboxJson(`/definition/workspace/publish`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({}),
            }),
        );
        workspace.value = { remote: result.remote, branch: result.branch, hosts: workspace.value?.hosts ?? [] };
        confirmingPublish.value = false;
    }, `Could not publish the workspace.`);

// The document
const derived = ref<DefinitionExport | undefined>(undefined);
const { busy: deriving, notice: deriveError, run: runDerive } = useAsyncAction();

// The document is small text, so unlike a bundle it downloads through an object URL rather than a ticket.
const downloadDefinition = (): Promise<void> =>
    runDerive(async () => {
        const answer = DefinitionExportSchema.parse(await sandboxJson(`/definition`));
        derived.value = answer;
        const url = URL.createObjectURL(new Blob([answer.toml], { type: `application/toml` }));
        const anchor = document.createElement(`a`);
        anchor.href = url;
        anchor.download = `sandbox.toml`;
        anchor.click();
        URL.revokeObjectURL(url);
    }, `Could not derive this sandbox's definition.`);

// The bundle
// Export state derives from the export directory (useBundleExports), surviving a refresh or view switch.
const { exports, packing, start, remove, error: listError } = useBundleExports();
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list this sandbox's bundles.`, detail: listError.value },
);

const { busy: starting, notice: startError, run: runStart } = useAsyncAction();

// Panel holds only whether the dialog is open; the answer belongs to <ExportBundleDialog>. Closed inside the task, so a
// failed start leaves the dialog up with the notice, not a reset button.
const exporting = ref(false);
const startExport = (secrets: boolean): Promise<void> =>
    runStart(async () => {
        await start(secrets);
        exporting.value = false;
    }, `Could not start the export.`);

// Navigates to the URL so the browser's own download manager takes over; a multi-GB bundle never passes through this
// tab's memory, and closing the tab doesn't cancel it.
const download = (entry: BundleExport): Promise<void> =>
    runStart(async () => {
        window.location.href = await bundleDownloadUrl(entry.name);
    }, `Could not start the download.`);

// The read
const diff = ref<DefinitionDiff | undefined>(undefined);
const { busy: comparing, notice: diffError, run: runDiff } = useAsyncAction();
const chooseCompare = ref<HTMLInputElement>();
const compare = (event: Event): Promise<void> =>
    runDiff(async () => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = ``;
        if (file === undefined) {
            return;
        }
        diff.value = DefinitionDiffSchema.parse(await sandboxJson(`/definition/diff`, { method: `POST`, body: await file.text() }));
    }, `Could not compare against that definition.`);
</script>

<template>
    <div class="flex flex-col gap-4">
        <!--
            Held back until the read lands: "Not published" offers a button that creates a repository, and showing it before the daemon answers would
            offer that wrongly to an owner who published months ago.
        -->
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
                        aria-label="Open the workspace repository"
                        v-tooltip.top="`Open the repository`"
                    >
                        <Icon name="external-link" class="text-sm" />
                    </a>
                    <CopyButton :text="workspace?.remote ?? ``" aria-label="Copy the clone URL" v-tooltip.top="`Copy the clone URL`" />
                </template>
            </Row>

            <!-- The description is what blocks the button, so a greyed-out control never needs a press to explain itself. -->
            <Row v-else icon="cloud-upload" title="Not published">
                <template #description>
                    <template v-if="host === undefined">Connect a GitHub or GitLab account first.</template>
                    <template v-else>Publish <span class="font-mono">/work</span>.</template>
                </template>
                <template #control>
                    <Button
                        v-if="!confirmingPublish"
                        label="Publish"
                        size="small"
                        severity="secondary"
                        :disabled="host === undefined"
                        @click="confirmingPublish = true"
                    />
                    <template v-else>
                        <Button label="Publish" size="small" :loading="publishing" @click="publish" />
                        <Button label="Cancel" size="small" severity="secondary" text @click="confirmingPublish = false" />
                    </template>
                </template>
                <!--
                    Shown only at the confirm moment, not as standing prose. `v-if` on the slot, not inside it: a passed slot is one the row renders,
                    margin included.
                -->
                <template v-if="confirmingPublish" #below>
                    <p class="text-2xs text-subtle">
                        Creates a private repository on {{ host }} and pushes <span class="font-mono">/work</span>. Secrets and
                        <span class="font-mono">.env</span> files stay behind.
                    </p>
                </template>
            </Row>
        </RowGroup>

        <!--
            Two fidelities side by side, so the choice between a publishable document and a private archive is visible at once; Compare rides along
            since it reads what Download writes.
        -->
        <div class="flex flex-wrap items-center gap-2">
            <Button label="Download sandbox.toml" size="small" :loading="deriving" @click="downloadDefinition">
                <template #icon><Icon name="download" /></template>
            </Button>
            <!--
                Disabled while one pack runs; two concurrent packs would only halve each other's speed, and the daemon 409s anyway. Ellipsis: the
                press opens a question, not the pack itself.
            -->
            <Button
                :label="packing ? 'Export running…' : 'Export environment…'"
                size="small"
                severity="secondary"
                :disabled="packing !== undefined"
                @click="exporting = true"
            >
                <template #icon><Icon name="box" /></template>
            </Button>
            <Button label="Compare sandbox.toml" size="small" severity="secondary" text :loading="comparing" @click="chooseCompare?.click()" />
            <input ref="chooseCompare" type="file" accept=".toml,text/plain,application/toml" class="hidden" @change="compare" />
        </div>

        <ExportBundleDialog :open="exporting" :busy="starting" @cancel="exporting = false" @confirm="startExport" />

        <!-- What the export could not express, said beside the file it just handed over. -->
        <RowGroup v-if="derived !== undefined && derived.omitted.length > 0" flat label="Not in the document">
            <Row v-for="entry in derived.omitted" :key="entry.subject" :title="entry.subject" :description="entry.detail" />
        </RowGroup>

        <!--
            Answers "where do I get it later". Download and delete are the same affordance (icon + tooltip, no bordered chip), the only two things
            anyone does to a file.
        -->
        <RowGroup v-if="exports.length > 0" flat label="Exports" :count="exports.length">
            <Row v-for="entry in exports" :key="entry.name">
                <template #title
                    ><span class="block truncate font-mono text-2xs">{{ entry.name }}</span></template
                >
                <template #description>
                    <template v-if="entry.status === 'packing'">Packing… {{ sizeLabel(entry.bytes) }} so far</template>
                    <template v-else-if="entry.status === 'failed'">{{ entry.error ?? `The export failed.` }}</template>
                    <template v-else>{{ sizeLabel(entry.bytes) }} · {{ formatDateTime(entry.createdAt) }}</template>
                </template>
                <template #meta>
                    <StatusBadge v-if="entry.secrets && entry.status === 'ready'" variant="warning" label="secrets" />
                    <StatusBadge v-if="entry.status === 'packing'" variant="info" label="packing" dot />
                    <StatusBadge v-else-if="entry.status === 'failed'" variant="danger" label="failed" dot />
                </template>
                <template #control>
                    <button
                        v-if="entry.status === 'ready'"
                        type="button"
                        :class="ui.iconButton()"
                        aria-label="Download export"
                        v-tooltip.top="'Download'"
                        v-action="() => download(entry)"
                    >
                        <Icon name="download" class="text-sm" />
                    </button>
                    <button
                        v-if="entry.status !== 'packing'"
                        type="button"
                        :class="ui.iconButton(`hover:text-danger`)"
                        aria-label="Delete export"
                        v-tooltip.top="'Delete this export'"
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
                <StatusBadge variant="success" label="in agreement" dot />
            </div>
            <RowGroup v-else flat label="Differences" :count="diff.differences.length">
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
