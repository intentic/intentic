<script setup lang="ts">
import { EnvironmentSchema } from "@intentic/api-contract";
import { Button, Code, Notice, type NoticeModel, RowGroup, RowNote, SegmentedControl, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { ENVIRONMENT_CONTENTS } from "../../../lib/queryKeys";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { ENVIRONMENT_KEY, useEnvironment } from "./useEnvironment";
import { useEnvironmentContents } from "./useEnvironmentContents";
import { useRole } from "../secrets/useRole";
import { useSandbox } from "../client/useSandbox";
import DevRebuild from "./rebuild/DevRebuild.vue";
import HostedRebuild from "./rebuild/HostedRebuild.vue";
import HostRecreate from "../../capabilities/connect/hosts/HostRecreate.vue";
import EnvironmentContents from "./EnvironmentContents.vue";
import RuntimeInstalls from "./RuntimeInstalls.vue";
import DiffToolbar from "../../workspace/viewers/DiffToolbar.vue";
import DiffView from "../../workspace/viewers/DiffView.vue";
import { useT } from "@intentic/ui/i18n";

// The sandbox's environment, read two ways: contents leads as the approval surface, the Dockerfile diff
// sits behind a pill. The decision (and its rebuild) is the card's first row, above both views: it
// concerns the environment's state, not its display, and the header badge it answers sits right above
// it. Approval pins the content's hash, and the rebuild itself runs outside the container (see
// HostRecreate).

const t = useT();

const queryClient = useQueryClient();
const { busy, notice, run } = useAsyncAction();
/* A role-gate refusal is not a fault, so it is not reported as one. */
const actionNotice = computed<NoticeModel | undefined>(() =>
    notice.value?.detail === `not a sandbox maintainer`
        ? { tone: `warning`, title: t(`sandbox.environmentCard.onlySandboxMaintainerDecide`) }
        : notice.value,
);

const { canShip: canOperate } = useRole();

// The derived environment state (shared with the shell's rebuild banner via one vue-query fetch).
const { state, query, isFetching, proposal, pending, applied, recurring, serverManaged, slug, localImage } = useEnvironment();

// A hosted sandbox has no host to run `ic` on, so its rebuild is a platform button (HostedRebuild) rather
// than a device command (HostRecreate). Read off the active sandbox's platform row.
const { active } = useSandbox();
const hosted = computed(() => (active.value?.hosted ? active.value.id : undefined));

// Named Recipe/Contents, not Source/Simplified: the plain view isn't the lesser one.
const view = ref<`contents` | `recipe`>(`contents`);
const VIEWS = computed(
    () =>
        [
            { label: t(`sandbox.environmentCard.contents`), value: `contents`, title: t(`sandbox.environmentCard.whatSandboxInstalled`) },
            { label: t(`sandbox.environmentCard.recipe`), value: `recipe`, title: t(`sandbox.environmentCard.overlayDockerfileBuilt`) },
        ] as const,
);

// Runs only while Contents is selected (probing versions spawns processes).
const { groups, loading, error: contentsError, refresh: reprobe } = useEnvironmentContents(() => view.value === `contents`);

// Each item's state (awaiting approval, arrives after rebuild) derives from the recipe, so a decision made here, or a
// proposal an agent drafts, must re-read contents; otherwise it shows stale until the tab is toggled off and on.
watch(
    () => [state.value?.proposal?.hash, state.value?.approved?.hash, state.value?.appliedHash, state.value?.custom?.hash].join(`|`),
    (next, previous) => {
        if (previous !== undefined && next !== previous) {
            void queryClient.invalidateQueries({ queryKey: ENVIRONMENT_CONTENTS.of() });
        }
    },
);

// Refreshes both reads and forces a re-probe, so a newly installed tool doesn't need a restart to show up.
const load = async (): Promise<void> => {
    reprobe();
    await query.refetch();
};

// Entries not yet dismissed; a dismissed install is a decided one and no longer a reason to show this card.
const awaiting = computed(() => recurring.value.filter((entry) => entry.declined !== true));

// Where the last decision was pressed, so a refusal is said beside that button: the proposal's decision is on the
// card's first row, a runtime install's at the foot of its own list, and one spot for both is far from one of them.
// One action between them, still, so the two never race each other's write.
const decidedAt = ref<`step` | `installs`>(`step`);
const decide = (at: `step` | `installs`, path: string, body?: object): Promise<void> => {
    decidedAt.value = at;
    return run(async () => {
        const next = EnvironmentSchema.parse(await sandboxJson(path, jsonBody(`POST`, body ?? {})));
        queryClient.setQueryData(ENVIRONMENT_KEY, next);
    }, `Could not update the environment.`);
};
const approve = (): Promise<void> => decide(`step`, `/environment/approve`, { hash: proposal.value?.hash });
const reject = (): Promise<void> => decide(`step`, `/environment/reject`);

// A base compiled from a checkout rebuilds from that checkout, and that rebuild applies the approved recipe as well
// (ic rebases the overlay onto the image it builds), so on this sandbox it is the card's ONE rebuild. The quicker
// recipe-only rebuild beside it was the same step offered twice, and the paragraphs it took to tell them apart were
// most of what the card said.
const fromCheckout = computed(() => localImage.value !== undefined && slug.value !== undefined && canOperate.value);

// Whether the first row has anything to hold: a proposal to decide, an approved recipe with a way to build it, or a
// checkout to rebuild from.
const step = computed(
    () =>
        proposal.value !== undefined ||
        fromCheckout.value ||
        (pending.value !== undefined && (hosted.value !== undefined || serverManaged.value || slug.value !== undefined)),
);
</script>

<template>
    <RowGroup v-if="proposal || pending || applied || awaiting.length" :label="t(`sandbox.words.environment`)">
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-2">
                <SegmentedControl v-model="view" :options="VIEWS" />
                <StatusBadge v-if="applied && !proposal && !pending" variant="success" :label="t(`sandbox.environmentCard.applied`)" dot />
                <StatusBadge v-else-if="pending && !proposal" variant="warning" :label="t(`sandbox.environmentCard.pendingRebuild`)" dot />
                <StatusBadge v-else variant="warning" :label="t(`sandbox.environmentCard.awaitingReview`)" dot />
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`ui.action.refresh`)"
                    v-tooltip.top="t(`ui.action.refresh`)"
                    @click="load"
                >
                    <!-- Uses `isFetching`, not `query.isFetching`: destructuring breaks the ref's auto-unwrap in templates, leaving the icon spin permanently true. -->
                    <Icon name="refresh" class="text-sm" :spin="isFetching" />
                </button>
            </div>
        </template>

        <!-- THE NEXT STEP LEADS THE CARD, under the badge that names it. It used to trail the longest list here, where
             it sat under "Installed at runtime" and read as an action on those rows, which have decisions of their
             own. No sentences around the buttons: the badge says what is waiting, the rows say what arrives, and
             each button's confirmation says what it costs. -->
        <RowNote v-if="step" variant="block" class="flex flex-col gap-3">
            <!-- Deciding comes first: approving changes what the rebuild builds, so it is the step that goes before.
                 Spinning only for its own press: a runtime install dismissed at the foot of the card holds these too,
                 but a wait drawn up here would be pinned to the wrong button. -->
            <template v-if="proposal">
                <div v-if="canOperate" class="flex flex-wrap items-center gap-2">
                    <Button :label="t(`ui.action.approve`)" size="small" :disabled="busy" :loading="busy && decidedAt === `step`" @click="approve">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                    <Button
                        :label="t(`sandbox.environmentCard.reject`)"
                        size="small"
                        severity="danger"
                        :text="true"
                        :disabled="busy"
                        :loading="busy && decidedAt === `step`"
                        @click="reject"
                    >
                        <template #icon><Icon name="times" /></template>
                    </Button>
                </div>
                <p v-else class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.onlySandboxOwnerApprove`) }}</p>
            </template>

            <!-- The platform builds it; owner-gated there, so a member sees the build with no button. -->
            <template v-if="pending && hosted">
                <HostedRebuild v-if="canOperate" :sandbox-id="hosted" :hash="pending.hash" :content="pending.content" />
                <p v-else class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.onlySandboxOwnerRebuild`) }}</p>
            </template>
            <p v-else-if="pending && serverManaged" class="text-2xs text-subtle">
                {{ t(`sandbox.environmentCard.appliesOnNext`) }}
                <span class="font-mono">intentic deploy apply</span>
                {{ t(`sandbox.environmentCard.againstSandboxsHost`) }}
            </p>
            <!-- Offered with nothing pending too, a tier down: there it picks up code, and the card isn't asking for it.
                 A tier down as well while a proposal waits, since deciding is the step before it. -->
            <DevRebuild
                v-else-if="localImage && slug && canOperate"
                :slug="slug"
                :base="localImage.base"
                :root="localImage.root"
                :recipe-pending="pending !== undefined"
                :secondary="pending === undefined || proposal !== undefined"
            />
            <!-- `bare`: no paragraph under the button, since its confirmation says what the rebuild costs; the class
                 puts back the column `bare` drops, so a running log keeps its gap. -->
            <HostRecreate
                v-else-if="pending && slug"
                :slug="slug"
                :hash="pending.hash"
                action="Rebuild"
                bare
                :text="proposal !== undefined"
                class="flex flex-col gap-2"
            />

            <Notice v-if="actionNotice && decidedAt === `step`" :of="actionNotice" />
        </RowNote>

        <!-- `gap-5` must match the section spacing in <EnvironmentContents>, so sections keep one rhythm. -->
        <RowNote variant="block" class="flex flex-col gap-5">
            <!-- Leads in every state, including a pending proposal (incoming entries show marked as awaiting approval). -->
            <EnvironmentContents v-if="view === `contents`" :groups="groups" :loading="loading" :error="contentsError" />

            <!-- A proposal awaiting the owner's decision, diffed against the approved custom section; capability fragments are daemon-owned and not up for review here. -->
            <template v-else-if="proposal">
                <div class="flex h-72 flex-col overflow-hidden rounded-lg border border-line">
                    <DiffToolbar path="environment.custom.Dockerfile" />
                    <DiffView
                        :key="proposal.hash"
                        :before="state?.custom?.content ?? ''"
                        :after="proposal.content"
                        path="environment.custom.Dockerfile"
                        class="min-h-0 flex-1"
                    />
                </div>
            </template>

            <!-- Approved but not yet built; the rebuild command pins this exact content's hash. -->
            <Code v-else-if="pending" :code="pending.content" lang="docker" :label="t(`sandbox.environmentCard.approvedOverlayPendingRebuild`)" />

            <!-- The active overlay the running container was built from. -->
            <Code v-else-if="applied" :code="applied.content" lang="docker" :label="t(`sandbox.environmentCard.activeOverlay`)" />

            <!-- Runtime installs sessions keep making, cross-session and drift-corroborated; fixable ones are usually already drafted into the proposal above.
                 The card ends on this list: its rows carry their own decisions, and nothing card-wide follows them. -->
            <RuntimeInstalls
                v-if="recurring.length"
                :entries="recurring"
                :can-operate="canOperate"
                :busy="busy"
                @decide="(tool, decision) => decide(`installs`, `/environment/runtime-install`, { tool, decision })"
            />

            <Notice v-if="actionNotice && decidedAt === `installs`" :of="actionNotice" />
        </RowNote>
    </RowGroup>
</template>
