<script setup lang="ts">
import { EnvironmentSchema, type EnvironmentItem } from "@intentic/api-contract";
import { Button, Code, ConfirmDialog, Notice, type NoticeModel, RowGroup, RowNote, SegmentedControl, StatusBadge, ui } from "@intentic/ui";
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

const { canShip: canOperate, isOwner } = useRole();

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
const { groups, loading, fetching, error: contentsError, refresh: reprobe, readAt } = useEnvironmentContents(() => view.value === `contents`);
// When the recipe last changed under an open card (the watch below re-reads Contents then): rows read before it cannot
// mark what the change proposes, so they do not count as its review.
const recipeChangedAt = ref(0);
// The proposal whose review is on screen: Approve answers what was shown, never a collapsed row a second old (on the
// phone the owner approved 1 s after the row appeared). Contents counts once its read has settled; the Recipe pill is
// the diff itself, drawn from the proposal the moment it is picked. Latched per proposal, so a background re-probe does
// not take the button away again, while a new proposal (a new hash) waits for its own rows. Latched before the render
// that draws the rows, so that render is the one that enables the button.
const shownFully = (): boolean =>
    view.value === `recipe` ||
    (!loading.value && !fetching.value && contentsError.value === undefined && readAt.value >= recipeChangedAt.value);
const reviewedHash = ref<string>();
watch(
    () => (shownFully() ? proposal.value?.hash : undefined),
    (hash) => {
        if (hash !== undefined) {
            reviewedHash.value = hash;
        }
    },
    { immediate: true },
);
const reviewed = computed(() => proposal.value !== undefined && reviewedHash.value === proposal.value.hash);
// What approving changes, said beside the button: the blocks Contents marks as awaiting it.
const proposedItems = computed(() => groups.value.flatMap((group) => group.items).filter((item) => item.state === `awaiting-approval`));
const proposalSummary = computed(() =>
    proposedItems.value.length > 0
        ? t(`sandbox.environmentCard.proposalAdds`, { names: proposedItems.value.map((item) => item.name).join(`, `) })
        : t(`sandbox.environmentCard.proposalChanges`),
);

// Each item's state (awaiting approval, arrives after rebuild) derives from the recipe, so a decision made here, or a
// proposal an agent drafts, must re-read contents; otherwise it shows stale until the tab is toggled off and on.
watch(
    () => [state.value?.proposal?.hash, state.value?.approved?.hash, state.value?.appliedHash, state.value?.custom?.hash].join(`|`),
    (next, previous) => {
        if (previous !== undefined && next !== previous) {
            recipeChangedAt.value = Date.now();
            void queryClient.invalidateQueries({ queryKey: ENVIRONMENT_CONTENTS.of() });
        }
    },
    // Synchronous, ahead of the review latch above: a proposal arriving under settled rows must not be latched in the
    // same flush it appears, before this has said those rows predate it.
    { flush: `sync` },
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
const decidedAt = ref<`step` | `installs` | `contents`>(`step`);
const decide = (at: `step` | `installs` | `contents`, path: string, body?: object): Promise<void> => {
    decidedAt.value = at;
    return run(async () => {
        const next = EnvironmentSchema.parse(await sandboxJson(path, jsonBody(`POST`, body ?? {})));
        queryClient.setQueryData(ENVIRONMENT_KEY, next);
    }, `Could not update the environment.`);
};
const approve = (): Promise<void> => decide(`step`, `/environment/approve`, { hash: proposal.value?.hash });
const reject = (): Promise<void> => decide(`step`, `/environment/reject`);

// TAKING ONE TOOL OUT, confirmed by name first. An approved one stays until the next rebuild, which the card then asks
// for like any other change; one still waiting for approval is only a request, dropped with nothing to rebuild.
const removing = ref<EnvironmentItem>();
const removeWords = computed(() => {
    const item = removing.value;
    if (item === undefined) {
        return undefined;
    }
    const { name } = item;
    const bodies = {
        active: () => t(`sandbox.environmentCard.removeApproved`, { name }),
        "after-rebuild": () => t(`sandbox.environmentCard.removeUnbuilt`, { name }),
        "awaiting-approval": () => t(`sandbox.environmentCard.removeRequest`, { name }),
    };
    return { header: t(`sandbox.environmentCard.removeHeader`, { name }), body: bodies[item.state]() };
});
const remove = (): Promise<void> => {
    const block = removing.value?.block;
    removing.value = undefined;
    return block === undefined ? Promise.resolve() : decide(`contents`, `/environment/remove`, { block });
};

// A base compiled from a checkout rebuilds from that checkout, and that rebuild applies the approved recipe as well
// (ic rebases the overlay onto the image it builds). That rebuild lives on the Sandbox tab only: the same button on two
// tabs read as two different actions, so while a recipe waits this card points there instead of offering it again.
const fromCheckout = computed(
    () => pending.value !== undefined && localImage.value !== undefined && slug.value !== undefined && canOperate.value,
);

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
                <p class="text-xs text-content">{{ proposalSummary }}</p>
                <div v-if="canOperate" class="flex flex-wrap items-center gap-2">
                    <Button :label="t(`ui.action.approve`)" size="small" :disabled="busy || !reviewed" :loading="busy && decidedAt === `step`" @click="approve">
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

            <!-- The platform builds it, for the sandbox's owner alone (sandbox.routes.ts `hostedRebuild`): a maintainer, who
                 may approve the change above, still sees the build with no button rather than one answered "sandbox not found". -->
            <template v-if="pending && hosted">
                <HostedRebuild v-if="isOwner" :sandbox-id="hosted" :hash="pending.hash" :content="pending.content" />
                <p v-else class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.onlySandboxOwnerRebuild`) }}</p>
            </template>
            <p v-else-if="pending && serverManaged" class="text-2xs text-subtle">
                {{ t(`sandbox.environmentCard.appliesOnNext`) }}
                <span class="font-mono">intentic deploy apply</span>
                {{ t(`sandbox.environmentCard.againstSandboxsHost`) }}
            </p>
            <!-- The checkout rebuild itself is on the Sandbox tab; this only points there. -->
            <p v-else-if="fromCheckout" data-executor="checkout" class="text-2xs text-subtle">
                {{ t(`sandbox.environmentCard.buildsWithCheckoutRebuild`) }}
                <RouterLink to="/sandbox" class="font-medium text-link hover:underline">{{ t(`sandbox.environmentCard.sandboxTab`) }}</RouterLink>
            </p>
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
            <EnvironmentContents
                v-if="view === `contents`"
                :groups="groups"
                :loading="loading"
                :error="contentsError"
                :removable="canOperate"
                :busy="busy"
                @remove="(item) => (removing = item)"
            />

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

            <!-- A removal pressed in Contents is refused right under the list it was pressed in. -->
            <Notice v-if="actionNotice && decidedAt === `contents`" :of="actionNotice" />

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

        <ConfirmDialog
            :open="removeWords !== undefined"
            :header="removeWords?.header ?? ``"
            :confirm-label="t(`sandbox.environmentCard.remove`)"
            confirm-icon="trash"
            @cancel="removing = undefined"
            @confirm="remove"
        >
            <p>{{ removeWords?.body }}</p>
        </ConfirmDialog>
    </RowGroup>
</template>
