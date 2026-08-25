<script setup lang="ts">
import {
    DefinitionDiffSchema,
    DefinitionExportSchema,
    DefinitionPlanSchema,
    DefinitionReportSchema,
    type DefinitionDiff,
    type DefinitionExport,
    type DefinitionPlan,
    type DefinitionReport,
} from "@intentic-app/api-contract";
import { Button, Card, NoticeStack, Row, RowGroup, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import { computed, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { useRole } from "../../composables/sandbox/useRole";

/* THE DEFINITION: this sandbox's declarable shape as a `sandbox.toml` anyone may read, beside the bundle card
 * that moves the whole of it. Three verbs, all owner-only on the daemon:
 *
 *   Download  derives the document from the live manifests, never from anything stored, so it cannot be
 *             stale, and lists what could not be expressed (a repo with no remote) instead of omitting it
 *             silently.
 *   Apply     is preview-first, the migration card's shape: a file becomes a ticked checklist, nothing writes
 *             until the apply, and what no apply can do (approve the overlay, enter credentials) is said at
 *             preview time and again on the report.
 *   Compare   answers where this sandbox stands relative to a definition file, one line per difference,
 *             writing nothing, which is the drift check a committed sandbox.toml earns.
 */

const { canShip: canOperate } = useRole();

const derived = ref<DefinitionExport | undefined>(undefined);
const plan = ref<DefinitionPlan | undefined>(undefined);
const ticked = ref<Record<string, boolean>>({});
const report = ref<DefinitionReport | undefined>(undefined);
const diff = ref<DefinitionDiff | undefined>(undefined);
const { busy: deriving, notice: deriveError, run: runDerive } = useAsyncAction();
const { busy: planning, notice: planError, run: runPlan } = useAsyncAction();
const { busy: applying, notice: applyError, run: runApply } = useAsyncAction();
const { busy: comparing, notice: diffError, run: runDiff } = useAsyncAction();

// The document is small text, so unlike a bundle it downloads through an object URL rather than a ticket.
const download = (): Promise<void> =>
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

const readFileText = async (event: Event): Promise<string | undefined> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = ``;
    return file === undefined ? undefined : file.text();
};

const chooseApply = ref<HTMLInputElement>();
const uploadForPlan = (event: Event): Promise<void> =>
    runPlan(async () => {
        const text = await readFileText(event);
        if (text === undefined) {
            return;
        }
        report.value = undefined;
        diff.value = undefined;
        const parsed = DefinitionPlanSchema.parse(await sandboxJson(`/definition/plan`, { method: `POST`, body: text }));
        plan.value = parsed;
        // Everything applicable starts ticked: a definition is applied for its whole shape far more often
        // than for a slice, and the inapplicable rows explain themselves either way.
        ticked.value = Object.fromEntries(parsed.items.filter((item) => item.applicable).map((item) => [item.id, true]));
    }, `Could not read that definition.`);

const chooseCompare = ref<HTMLInputElement>();
const uploadForDiff = (event: Event): Promise<void> =>
    runDiff(async () => {
        const text = await readFileText(event);
        if (text === undefined) {
            return;
        }
        report.value = undefined;
        plan.value = undefined;
        diff.value = DefinitionDiffSchema.parse(await sandboxJson(`/definition/diff`, { method: `POST`, body: text }));
    }, `Could not compare against that definition.`);

const tickedCount = computed(() => Object.values(ticked.value).filter(Boolean).length);

const apply = (): Promise<void> =>
    runApply(async () => {
        const held = plan.value;
        if (held === undefined) {
            return;
        }
        const items = held.items.filter((item) => ticked.value[item.id] === true).map((item) => item.id);
        report.value = DefinitionReportSchema.parse(
            await sandboxJson(`/definition/apply`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ token: held.token, items }),
            }),
        );
        plan.value = undefined;
    }, `Could not apply the definition.`);

const cancel = (): Promise<void> =>
    runPlan(async () => {
        await sandboxJson(`/definition/plan`, { method: `DELETE` });
        plan.value = undefined;
    }, `Could not discard the plan.`);
</script>

<template>
    <Card class="flex flex-col gap-4">
        <Row flush :heading="2" icon="file-edit" title="Sandbox definition" />

        <template v-if="canOperate">
            <p class="text-2xs text-subtle">
                The declarable shape of this sandbox as a <span class="font-mono">sandbox.toml</span>: repositories by remote, connections by
                shape, secret names, the overlay source. Safe to publish — credentials never travel, and its overlay lands on a target as a
                proposal, never as a build.
            </p>

            <div v-if="plan === undefined" class="flex flex-wrap items-center gap-2">
                <Button label="Download sandbox.toml" size="small" :loading="deriving" @click="download">
                    <template #icon><Icon name="download" /></template>
                </Button>
                <Button label="Apply a definition" size="small" severity="secondary" :loading="planning" @click="chooseApply?.click()">
                    <template #icon><Icon name="upload" /></template>
                </Button>
                <Button label="Compare against one" size="small" severity="secondary" :loading="comparing" @click="chooseCompare?.click()" />
                <input ref="chooseApply" type="file" accept=".toml,text/plain,application/toml" class="hidden" @change="uploadForPlan" />
                <input ref="chooseCompare" type="file" accept=".toml,text/plain,application/toml" class="hidden" @change="uploadForDiff" />
            </div>

            <!-- What the export could not express, said beside the file it just handed over. -->
            <div v-if="derived !== undefined && derived.omitted.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p class="text-xs font-medium text-content">Not in the file</p>
                <div v-for="entry in derived.omitted" :key="entry.subject" class="text-2xs">
                    <p class="font-medium text-content">{{ entry.subject }}</p>
                    <p class="text-subtle">{{ entry.detail }}</p>
                </div>
            </div>

            <!-- The plan: every item a row with its tick, inapplicable rows greyed with their reason. Nothing
                 below this writes until Apply, the migration card's discipline. -->
            <template v-if="plan !== undefined">
                <div class="flex items-center gap-2">
                    <StatusBadge variant="info" :label="plan.name ?? `Definition`" />
                    <p class="text-2xs text-subtle">Untick anything you don't want. Nothing is written until you apply.</p>
                </div>
                <RowGroup>
                    <Row
                        v-for="item in plan.items"
                        :key="item.id"
                        :as="item.applicable ? `label` : `div`"
                        density="compact"
                        :class="item.applicable ? `cursor-pointer` : `opacity-60`"
                    >
                        <template #title
                            ><span class="text-xs">{{ item.label }}</span></template
                        >
                        <template #description>{{ item.applicable ? item.detail : item.reason }}</template>
                        <template #meta>
                            <StatusBadge v-if="!item.applicable" variant="info" label="Already here" />
                        </template>
                        <template #control>
                            <Checkbox v-if="item.applicable" v-model="ticked[item.id]" binary />
                        </template>
                    </Row>
                </RowGroup>

                <div v-if="plan.needsAction.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                    <p class="text-xs font-medium text-content">Won't happen by itself</p>
                    <div v-for="action in plan.needsAction" :key="action.subject" class="text-2xs">
                        <p class="font-medium text-content">{{ action.subject }}</p>
                        <p class="text-subtle">{{ action.detail }}</p>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    <Button
                        :label="`Apply ${tickedCount} item${tickedCount === 1 ? `` : `s`}`"
                        size="small"
                        :loading="applying"
                        :disabled="tickedCount === 0"
                        @click="apply"
                    />
                    <Button label="Cancel" size="small" severity="secondary" text @click="cancel" />
                </div>
            </template>

            <!-- Drift: where this sandbox stands relative to the compared file. Agreement is a sentence, not
                 an empty box, because "no differences" is the answer the check exists to give. -->
            <template v-if="diff !== undefined">
                <div v-if="diff.differences.length === 0" class="flex items-center gap-2">
                    <StatusBadge variant="success" label="In agreement" dot />
                    <p class="text-2xs text-subtle">This sandbox matches that definition.</p>
                </div>
                <div v-else class="flex flex-col gap-2 rounded-lg border border-line p-3">
                    <p class="text-xs font-medium text-content">
                        {{ diff.differences.length }} difference{{ diff.differences.length === 1 ? `` : `s` }}
                    </p>
                    <div v-for="difference in diff.differences" :key="difference.subject + difference.detail" class="text-2xs">
                        <p class="font-medium text-content">{{ difference.subject }}</p>
                        <p class="text-subtle">{{ difference.detail }}</p>
                    </div>
                </div>
            </template>
        </template>
        <p v-else class="text-2xs text-subtle">Only the sandbox owner can export or apply a definition.</p>

        <!-- The fidelity report, the same anatomy as a bundle restore's: what landed, what failed and why,
             and what still needs a person. -->
        <template v-if="report">
            <div class="flex items-center gap-2">
                <StatusBadge variant="success" label="Applied" dot />
                <p class="text-2xs text-subtle">{{ report.applied.length }} item{{ report.applied.length === 1 ? `` : `s` }} landed.</p>
            </div>
            <div v-if="report.failed.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p class="text-xs font-medium text-danger">Didn't land</p>
                <div v-for="failure in report.failed" :key="failure.id" class="text-2xs">
                    <p class="font-medium text-content">{{ failure.label }}</p>
                    <p class="text-subtle">{{ failure.error }}</p>
                </div>
            </div>
            <div v-if="report.needsAction.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p class="text-xs font-medium text-content">Finish the arrival</p>
                <div v-for="action in report.needsAction" :key="action.subject" class="text-2xs">
                    <p class="font-medium text-content">{{ action.subject }}</p>
                    <p class="text-subtle">{{ action.detail }}</p>
                </div>
            </div>
        </template>

        <NoticeStack :of="[deriveError, planError, applyError, diffError]" />
    </Card>
</template>
