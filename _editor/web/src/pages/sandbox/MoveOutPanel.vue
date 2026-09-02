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
} from "@intentic-app/api-contract";
import { Button, CopyButton, formatDateTime, type NoticeModel, NoticeStack, Row, RowGroup, StatusBadge, ui, vAction } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { bundleDownloadUrl, useBundleExports } from "../../composables/sandbox/useBundleExports";
import ExportBundleDialog from "./ExportBundleDialog.vue";
import { workspaceRepoOf } from "./workspaceRepo";

/* THE OUTBOUND HALF OF <MoveCard>: everything that LEAVES this sandbox, at all three fidelities, because it is
 * one job.
 *
 * It used to be two cards. "Move this sandbox" held the bundle and "Sandbox definition" held the `sandbox.toml`,
 * which put them on two different AXES — one named a job, the other named a file — and the consequence was
 * that whoever wanted to move a sandbox read the first card, exported gigabytes of private bytes, and never
 * discovered that the reference-only document they could publish existed at all. The two are not neighbours;
 * they are the same verb at two fidelities, and a bundle literally CONTAINS the definition (its manifest
 * embeds one, see bundle.ts). So they are two buttons in one row now, and the paragraph under the row is the
 * choice between them.
 *
 * THE ORDER IS THE ARGUMENT. Publishing the workspace comes first because it is what a definition can carry
 * once it exists and cannot before; the document comes before the bundle because it is the safe one; and
 * comparing sits last because it is the one verb here that writes nothing at all.
 *
 * THE PANEL OWNS NO CARD AND NO ROLE CHECK. Both belong to <MoveCard>, which draws this half and the inbound
 * one on a single surface and says "only the owner can move this sandbox" once instead of twice. */

// ---- the workspace repo, the half a definition cannot supply for itself ----
const workspace = ref<WorkspaceRemote | undefined>(undefined);
const confirmingPublish = ref(false);
const { notice: workspaceError, run: runWorkspace } = useAsyncAction();
const { busy: publishing, notice: publishError, run: runPublish } = useAsyncAction();

/* Read on first render rather than behind a button: whether /work is published decides whether a downloaded
 * definition carries this sandbox's own content at all, so it is the first thing the panel has to say, not
 * something the owner discovers in an omissions list after downloading. */
const published = computed(() => (workspace.value?.remote === undefined ? undefined : workspaceRepoOf(workspace.value.remote)));
const host = computed(() => workspace.value?.hosts[0]);

const loadWorkspace = (): Promise<void> =>
    runWorkspace(async () => {
        workspace.value = WorkspaceRemoteSchema.parse(await sandboxJson(`/definition/workspace`));
    }, `Could not read the workspace repo.`);

onMounted(() => {
    void loadWorkspace();
});

// Publishing is OUTWARD, so it is confirmed rather than one click: it creates a repository on somebody's
// account and pushes the workspace into it.
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

// ---- the document ----
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

// ---- the bundle ----
/* Everything about exports is DERIVED from the daemon's export directory (useBundleExports), which is what
 * makes an export findable later. The first cut streamed the bundle down the click's own response and held its
 * state in a local `busy` ref: switching view or refreshing abandoned the pack AND lost every trace of it,
 * leaving a reset button and no answer to "where did my export go". */
const { exports, packing, start, remove, error: listError } = useBundleExports();
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list this sandbox's bundles.`, detail: listError.value },
);

const { busy: starting, notice: startError, run: runStart } = useAsyncAction();

/* THE EXPORT'S ONE ARGUMENT IS ASKED FOR BEHIND THE BUTTON, NOT UNDER IT — see <ExportBundleDialog> for why a
 * standing switch was the wrong shape for something no state remembers. The panel holds only "is the question
 * open"; the answer is the dialog's, for the length of one export.
 *
 * Closed INSIDE the task, so it survives a refusal: a failed start leaves the dialog up with the notice under
 * the card, rather than dismissing the reader back to a button that looks untouched. */
const exporting = ref(false);
const startExport = (secrets: boolean): Promise<void> =>
    runStart(async () => {
        await start(secrets);
        exporting.value = false;
    }, `Could not start the export.`);

/* Navigating to the URL is the point: the browser's own download manager takes the file, with a real
 * Content-Length behind it, so a multi-GB bundle never passes through this tab's memory, and closing the tab
 * afterwards does not cancel it. */
const download = (entry: BundleExport): Promise<void> =>
    runStart(async () => {
        window.location.href = await bundleDownloadUrl(entry.name);
    }, `Could not start the download.`);

// ---- the read ----
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

const sizeLabel = (bytes: number): string => {
    const units = [`B`, `KB`, `MB`, `GB`];
    const index = Math.min(units.length - 1, bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- THE WORKSPACE REPO, as the one record it is: which repository, on which branch, and the two
             things anyone does with a repository once it exists. Held back until the read lands, because the
             two states are not equally cheap to be wrong about: "Not published" carries a button that creates
             a repository, and drawing it for the beat before the daemon answers offers that to owners who
             published months ago. -->
        <RowGroup v-if="workspace !== undefined" flat label="Workspace">
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

            <!-- Unpublished. What blocks the button IS the row's description, so the reader never presses a
                 greyed-out control to find out why it is grey. -->
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
                <!-- WHAT STAYS BEHIND, at the moment it decides something. As standing prose it was four lines
                     of caveat every reader scrolled past, and here it answers the question the confirm step
                     asks. `v-if` on the slot, not inside it: a slot that is passed is a slot the row renders,
                     margin and all. -->
                <template v-if="confirmingPublish" #below>
                    <p class="text-2xs text-subtle">
                        Creates a private repository on {{ host }} and pushes <span class="font-mono">/work</span>. Secrets and
                        <span class="font-mono">.env</span> files stay behind.
                    </p>
                </template>
            </Row>
        </RowGroup>

        <!-- THE TWO FIDELITIES, SIDE BY SIDE, which is the whole point of merging the cards: the choice
             between a publishable document and a private archive is a choice, and a reader can only make it
             when both are in front of them. The compare button rides along because it reads the same document
             the first button writes. -->
        <div class="flex flex-wrap items-center gap-2">
            <Button label="Download sandbox.toml" size="small" :loading="deriving" @click="downloadDefinition">
                <template #icon><Icon name="download" /></template>
            </Button>
            <!-- Disabled while one is packing rather than queueing a second: two concurrent packs would halve
                 each other's speed to produce near-identical files, and the daemon 409s anyway. The ellipsis
                 is not decoration — the press opens a question now and starts the pack after it. -->
            <Button
                :label="packing ? 'Export running…' : 'Export environment…'"
                size="small"
                severity="secondary"
                :disabled="packing !== undefined"
                @click="exporting = true"
            >
                <template #icon><Icon name="box" /></template>
            </Button>
            <Button label="Compare against one" size="small" severity="secondary" text :loading="comparing" @click="chooseCompare?.click()" />
            <input ref="chooseCompare" type="file" accept=".toml,text/plain,application/toml" class="hidden" @change="compare" />
        </div>
        <p class="text-2xs text-subtle">
            <span class="font-mono">sandbox.toml</span> is references only. A bundle adds the state; never publish one.
        </p>

        <ExportBundleDialog :open="exporting" :busy="starting" @cancel="exporting = false" @confirm="startExport" />

        <!-- What the export could not express, said beside the file it just handed over. -->
        <RowGroup v-if="derived !== undefined && derived.omitted.length > 0" flat label="Not in the document">
            <Row v-for="entry in derived.omitted" :key="entry.subject" :title="entry.subject" :description="entry.detail" />
        </RowGroup>

        <!-- THE ANSWER TO "where do I get it later": the exports that exist, whatever this tab has been doing.
             BOTH ACTIONS ARE THE SAME AFFORDANCE, and that is the fix to a row that had two: download was a
             bordered chip and delete a bare glyph, so the quieter of the two (throwing the file away) was the
             one drawing a box. Neither needs a label because the row is one file and these are the only two
             things anyone does to a file; the tooltip carries the word. -->
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

        <!-- Drift: where this sandbox stands relative to the compared file. Agreement is a sentence, not an
             empty box, because "no differences" is the answer the check exists to give. -->
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
