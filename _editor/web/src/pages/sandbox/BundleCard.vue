<script setup lang="ts">
import { ImportReportSchema, type BundleExport, type ImportReport } from "@intentic-app/api-contract";
import { Button, Card, ui, formatDateTime, type NoticeModel, NoticeStack, Row, RowGroup, StatusBadge, vAction } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { bundleDownloadUrl, useBundleExports } from "../../composables/sandbox/useBundleExports";
import { useRole } from "../../composables/sandbox/useRole";

/* MOVING A SANDBOX: export this one's environment to a file, or restore one into this sandbox.
 *
 * Everything on the left of this card is DERIVED from the daemon's export directory (useBundleExports), which
 * is what makes an export findable later. The first cut streamed the bundle down the click's own response and
 * held its state in a local `busy` ref: switching view or refreshing abandoned the pack AND lost every trace of
 * it, leaving a reset button and no answer to "where did my export go". Now the click starts a job, the row
 * appears at once, and the row is still there (packing, ready or failed) however the browser is treated in
 * the minutes that follow.
 *
 * The container still cannot travel, which is why a restore ends in a report rather than a success tick: the
 * image the overlay describes is built by the machine running the container.
 */

const { canShip: canOperate } = useRole();
const { exports, packing, start, remove, error: listError } = useBundleExports();
// The query carries a raw message and no idea what the user was after; the card does, so the card writes
// the sentence and keeps the message underneath as evidence.
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list this sandbox's bundles.`, detail: listError.value },
);

const withSecrets = ref(false);
const report = ref<ImportReport | undefined>(undefined);
const { busy: starting, notice: startError, run: runStart } = useAsyncAction();
const { busy: importing, notice: importError, run: runImport } = useAsyncAction();

const startExport = (): Promise<void> => runStart(() => start(withSecrets.value), `Could not start the export.`);

/* Navigating to the URL is the point: the browser's own download manager takes the file, with a real
 * Content-Length behind it, so a multi-GB bundle never passes through this tab's memory, and closing the tab
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
        // One continuous body, like the folder-drop archive route: the daemon streams it to disk entry by entry.
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
        <Row flush :heading="2" icon="box" title="Move this sandbox" />

        <template v-if="canOperate">
            <!-- THE ONE DECISION THIS CARD ASKS FOR, on the card's own surface. It used to sit in its own boxed
                 inset, which read as a second card inside the first for a border that said nothing the hairline
                 doesn't. The lock is the state at a glance: it opens and goes warning-coloured the moment the
                 bundle stops being safe to hand over, so the danger is legible before the sentence is read.

                 FULL-BLEED, because the whole row is the click target and the hover tint has to show that. A
                 `flush` row keeps no padding of its own, so the tint was painted on the text's own box: a
                 rectangle starting at the divider and stopping dead against the lock on one side and the toggle
                 on the other, with no air anywhere.

                 THE BLEED IS THE WRAPPER'S, NOT THE ROW'S, and it has to be: a <Row> carries `w-full`, and a
                 negative side margin on a box whose width is pinned to 100% SLIDES it instead of widening it:
                 the band hung a card-padding over the left edge and finished a card-padding short of the right,
                 which is the \"still not full-width\" of the second report. An undecorated wrapper has no width of
                 its own, so `-mx-5` widens it by the card's padding on both sides (`5`, like
                 `--ui-card-padding`), and the row inside is 100% of THAT. The row keeps the padding, so the
                 words stay lined up with everything else on the card while the tint runs edge to edge. -->
            <div class="-mx-5 border-t border-line-subtle">
                <!-- `density="compact"`, which is what stops this reading as a SECOND card title. At the
                     comfortable tier a row's title is `font-semibold` at the body size, a hair off the
                     masthead's own `text-lg font-semibold`, so a lock, a bold phrase and a control sitting
                     directly under "Move this sandbox" scanned as the heading of a card of its own. It is one
                     option on this card, and the compact tier is the app's word for that. -->
                <Row
                    flush
                    as="label"
                    density="compact"
                    :icon="withSecrets ? `unlock` : `lock`"
                    :tone="withSecrets ? `warning` : `default`"
                    title="Include secrets"
                    class="px-5 py-2.5"
                    :class="packing === undefined ? `cursor-pointer` : `cursor-default`"
                >
                    <template #control>
                        <ToggleSwitch v-model="withSecrets" :disabled="packing !== undefined" />
                    </template>
                    <!-- `v-if` ON THE SLOT, not on a <p> inside it. A slot that is always PASSED is always
                         rendered, so the row drew its `#below` wrapper (margin and all) around nothing
                         whenever the warning was off, which is where the band's uneven top and bottom came
                         from: eleven pixels of padding above the title and twenty-four below the sentence. -->
                    <template v-if="withSecrets" #below>
                        <p class="text-2xs text-warning">The exported file will contain credentials in the clear. Store it like a password.</p>
                    </template>
                </Row>
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

        <!-- THE ANSWER TO "where do I get it later": the exports that exist, whatever this tab has been doing.
             A <RowGroup> of <Row>s rather than the hand-drawn list this was: the anatomy is a record list's
             (a name, a line of facts under it, a badge, two actions), which is the shape those two components
             exist to state once.

             BOTH ACTIONS ARE THE SAME AFFORDANCE, and that is the fix to a row that had two. Download was a
             bordered chip and delete a bare glyph, so the quieter of the two (throwing the file away) was
             the one drawing a box, and the row read as a button with a stray mark after it. `ui.iconButton`
             is the app's toolbar action: no chrome until the pointer is on it, the tone arriving with the
             hover. Neither needs a label because the row is one file and these are the only two things anyone
             does to a file; the tooltip carries the word. -->
        <RowGroup v-if="exports.length > 0" flat label="Exports" :count="exports.length">
            <Row v-for="entry in exports" :key="entry.name" density="compact">
                <template #title
                    ><span class="block truncate font-mono text-2xs">{{ entry.name }}</span></template
                >
                <template #description>
                    <template v-if="entry.status === 'packing'">Packing… {{ sizeLabel(entry.bytes) }} so far</template>
                    <template v-else-if="entry.status === 'failed'">{{ entry.error ?? `The export failed.` }}</template>
                    <template v-else>{{ sizeLabel(entry.bytes) }} · {{ formatDateTime(entry.createdAt) }}</template>
                </template>
                <template #meta>
                    <StatusBadge v-if="entry.secrets && entry.status === 'ready'" variant="warning" label="Secrets" />
                    <StatusBadge v-if="entry.status === 'packing'" variant="info" label="Packing" dot />
                    <StatusBadge v-else-if="entry.status === 'failed'" variant="danger" label="Failed" dot />
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
                        v-if="canOperate && entry.status !== 'packing'"
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

        <p v-if="canOperate" class="text-2xs text-subtle">
            Exports stay on the sandbox until you delete them, so you can come back for one later. Restore onto a FRESH sandbox: it overwrites files
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
            <RowGroup v-if="report.needsAction.length > 0" flat label="Finish the move">
                <Row
                    v-for="action in report.needsAction"
                    :key="action.subject"
                    density="compact"
                    :title="action.subject"
                    :description="action.detail"
                />
            </RowGroup>
            <p v-if="report.refused.length > 0" class="text-2xs text-warning">
                {{ report.refused.length }} entries were refused: the bundle carried paths this sandbox does not accept (identity files, or paths
                outside the workspace).
            </p>
        </template>

        <NoticeStack :of="[startError, importError, listNotice]" />
    </Card>
</template>
