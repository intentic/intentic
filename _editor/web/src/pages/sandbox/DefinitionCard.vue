<script setup lang="ts">
import {
    DefinitionDiffSchema,
    DefinitionExportSchema,
    DefinitionPlanSchema,
    DefinitionReportSchema,
    WorkspacePublishResultSchema,
    WorkspaceRemoteSchema,
    type DefinitionDiff,
    type DefinitionExport,
    type DefinitionPlan,
    type DefinitionReport,
    type WorkspaceRemote,
} from "@intentic-app/api-contract";
import { Button, Card, CopyButton, NoticeStack, Row, RowGroup, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { useRole } from "../../composables/sandbox/useRole";
import { workspaceRepoOf } from "./workspaceRepo";

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

/* THE WORKSPACE REPO, read on first render rather than behind a button: whether /work is published decides
 * whether a downloaded definition carries this sandbox's own content at all, so it is the first thing the card
 * has to say, not something the owner discovers in an omissions list after downloading. */
const workspace = ref<WorkspaceRemote | undefined>(undefined);
const confirmingPublish = ref(false);
const { notice: workspaceError, run: runWorkspace } = useAsyncAction();
const { busy: publishing, notice: publishError, run: runPublish } = useAsyncAction();

// The remote as a row reads it: which repository this is, and the page it opens. See workspaceRepo.ts.
const published = computed(() => (workspace.value?.remote === undefined ? undefined : workspaceRepoOf(workspace.value.remote)));
const host = computed(() => workspace.value?.hosts[0]);

const loadWorkspace = (): Promise<void> =>
    runWorkspace(async () => {
        workspace.value = WorkspaceRemoteSchema.parse(await sandboxJson(`/definition/workspace`));
    }, `Could not read the workspace repo.`);

onMounted(() => {
    if (canOperate.value) {
        void loadWorkspace();
    }
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
            <!-- THE WORKSPACE REPO, as the one record it is: which repository, on which branch, and the two
                 things anyone does with a repository once it exists. It was a paragraph in a boxed inset,
                 which got both halves wrong. The box drew a second card inside the first for a border that
                 said nothing the card's own hairline doesn't (<BundleCard> had the same inset removed for the
                 same reason), and the paragraph buried the remote mid-sentence: the one fact a reader wants
                 from this block arrived as a sixty-character URL ending in `.git`, unfollowable and
                 unselectable without dragging across the words around it.

                 A `flat` <RowGroup> is the app's answer to a group already sitting on a surface, and the row's
                 own anatomy is exactly this record's: a host mark, the project, the branch as a trailing fact,
                 the verbs on the right. Both states are the SAME row, so publishing changes what the row says
                 rather than swapping one block of prose for another.

                 Held back until the read lands, because the two states are not equally cheap to be wrong
                 about: "Not published" carries a button that creates a repository, and drawing it for the beat
                 before the daemon answers offers that to owners who published months ago. -->
            <RowGroup v-if="plan === undefined && workspace !== undefined" flat label="Workspace">
                <Row v-if="published !== undefined" :icon="published.icon">
                    <template #title
                        ><span class="block truncate font-mono text-2xs">{{ published.project }}</span></template
                    >
                    <template #description>
                        Every definition carries it as <span class="font-mono">[workspace]</span>: notes, skills, personas, automations, designs and
                        drafts.
                    </template>
                    <!-- The branch is a fact about the row, so it sits with the facts and stays unclickable. -->
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
                        <template v-if="host === undefined">Connect a GitHub or GitLab account first. That is what creates the repository.</template>
                        <template v-else
                            >Publish <span class="font-mono">/work</span> to carry this sandbox's own notes, skills, personas, automations, designs
                            and drafts.</template
                        >
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
                    <!-- WHAT STAYS BEHIND, at the moment it decides something. As standing prose it was four
                         lines of caveat every reader scrolled past, and here it answers the question the
                         confirm step asks. `v-if` on the slot, not inside it: a slot that is passed is a slot
                         the row renders, margin and all. -->
                    <template v-if="confirmingPublish" #below>
                        <p class="text-2xs text-subtle">
                            Creates a private repository on {{ host }} and pushes <span class="font-mono">/work</span> to it. Nested repositories, the
                            reference shelf, credentials, browser sessions and <span class="font-mono">.env</span> files stay behind.
                        </p>
                    </template>
                </Row>

                <!-- THE DEFINITION AS A FILE, which is the answer to "where do I actually read this". The card
                     had one door and it was a download: the agent working in this sandbox could not read what
                     the sandbox is, and neither could anyone who wanted the shape in a diff rather than in a
                     browser. The daemon keeps `sandbox.toml` at the root now (portability/definition-file.ts),
                     so the honest thing for this card to do is point at it.

                     A <RouterLink> around the row rather than <Row>'s own `href`, which the component is
                     explicit about: `href` renders a new-tab anchor, and this is in-app navigation. -->
                <RouterLink to="/workspace/sandbox.toml" class="block">
                    <Row interactive chevron icon="file-edit">
                        <template #title><span class="block truncate font-mono text-2xs">sandbox.toml</span></template>
                        <template #description>
                            Kept at the workspace root and rewritten when this sandbox changes. Commit it to diff your environment over time.
                        </template>
                    </Row>
                </RouterLink>
            </RowGroup>

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
            <RowGroup v-if="derived !== undefined && derived.omitted.length > 0" flat label="Not in the file">
                <Row v-for="entry in derived.omitted" :key="entry.subject" :title="entry.subject" :description="entry.detail" />
            </RowGroup>

            <!-- The plan: every item a row with its tick, inapplicable rows greyed with their reason. Nothing
                 below this writes until Apply, the migration card's discipline. -->
            <template v-if="plan !== undefined">
                <div class="flex items-center gap-2">
                    <StatusBadge variant="info" :label="plan.name ?? `Definition`" />
                    <p class="text-2xs text-subtle">Untick anything you don't want. Nothing is written until you apply.</p>
                </div>
                <RowGroup flat label="What would land">
                    <Row
                        v-for="item in plan.items"
                        :key="item.id"
                        :as="item.applicable ? `label` : `div`"
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

                <RowGroup v-if="plan.needsAction.length > 0" flat label="Won't happen by itself">
                    <Row v-for="action in plan.needsAction" :key="action.subject" :title="action.subject" :description="action.detail" />
                </RowGroup>

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
                <RowGroup v-else flat label="Differences" :count="diff.differences.length">
                    <Row
                        v-for="difference in diff.differences"
                        :key="difference.subject + difference.detail"
                        :title="difference.subject"
                        :description="difference.detail"
                    />
                </RowGroup>
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
            <!-- The failure group wears the tone its heading always did: <RowGroup>'s label is a slot precisely
                 so a group whose subject is a failure can say so without the component learning about tones. -->
            <RowGroup v-if="report.failed.length > 0" flat>
                <template #label><span :class="ui.sectionLabel(`text-danger`)">Didn't land</span></template>
                <Row v-for="failure in report.failed" :key="failure.id" :title="failure.label" :description="failure.error" />
            </RowGroup>
            <RowGroup v-if="report.needsAction.length > 0" flat label="Finish the arrival">
                <Row v-for="action in report.needsAction" :key="action.subject" :title="action.subject" :description="action.detail" />
            </RowGroup>
        </template>

        <NoticeStack :of="[deriveError, planError, applyError, diffError, workspaceError, publishError]" />
    </Card>
</template>
