<script setup lang="ts">
import type { Environment, EnvironmentItem } from "@intentic/sandbox-contract";
import { Button, Code, ConfirmDialog, Notice, type NoticeModel, RowGroup, RowNote, SegmentedControl, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ENVIRONMENT_CONTENTS } from "../../../lib/queryKeys";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { ENVIRONMENT_KEY, useEnvironment } from "./useEnvironment";
import { useEnvironmentContents } from "./useEnvironmentContents";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import HostedRebuild from "./rebuild/HostedRebuild.vue";
import { rebuildRouteOf } from "./rebuild/rebuildRoute";
import { REBUILD_ANCHOR } from "./rebuildAnchor";
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
const decide = (at: `step` | `installs` | `contents`, write: () => Promise<Environment>): Promise<void> => {
    decidedAt.value = at;
    return run(async () => {
        queryClient.setQueryData(ENVIRONMENT_KEY, await write());
    }, t(`sandbox.environmentCard.couldNotUpdate`));
};
const approve = (): Promise<void> => {
    const hash = proposal.value?.hash;
    return hash === undefined ? Promise.resolve() : decide(`step`, () => sandboxRaw(`POST /environment/approve`, { input: { hash } }));
};
const reject = (): Promise<void> => decide(`step`, () => sandboxRaw(`POST /environment/reject`));

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
    return block === undefined ? Promise.resolve() : decide(`contents`, () => sandboxRaw(`POST /environment/remove`, { input: { block } }));
};

// A base compiled from a checkout rebuilds from that checkout, and that rebuild applies the approved recipe as well
// (ic rebases the overlay onto the image it builds). That rebuild lives on the Sandbox tab only: the same button on two
// tabs read as two different actions, so while a recipe waits this card points there instead of offering it again.
const fromCheckout = computed(
    () => pending.value !== undefined && localImage.value !== undefined && slug.value !== undefined && canOperate.value,
);

// What Contents says arrives with a rebuild, named where the card says why none is offered.
const arriving = computed(() => groups.value.flatMap((group) => group.items).filter((item) => item.state === `after-rebuild`));

// How a rebuild happens from here, or why it doesn't (rebuildRoute.ts). Every lane draws something: the card once drew
// nothing at all for a container with no rebuild route, under a banner asking for one.
const route = computed(() =>
    rebuildRouteOf({
        pending: pending.value !== undefined,
        arriving: arriving.value.length > 0,
        hosted: hosted.value !== undefined,
        owner: isOwner.value,
        serverManaged: serverManaged.value,
        fromCheckout: fromCheckout.value,
        slug: slug.value,
    }),
);

// Whether the first row has anything to hold: a proposal to decide, or the rebuild and what stands in for it.
const step = computed(() => proposal.value !== undefined || route.value !== undefined);

// ARRIVING ON THE BANNER'S LINK (`#sandbox-rebuild`) lands on the rebuild rather than the top of the page: the step is
// scrolled to and its button focused, or the step itself where it is a sentence. Watched rather than done once on mount,
// since the card draws only once the environment is read, after the router's own scroll found nothing to scroll to.
const currentRoute = useRoute();
const rebuildStep = ref<HTMLElement>();
let arrivedFor: string | undefined;
watch(
    [() => currentRoute.fullPath, rebuildStep],
    async ([path, element]) => {
        if (element === undefined || currentRoute.hash !== `#${REBUILD_ANCHOR}` || arrivedFor === path) {
            return;
        }
        arrivedFor = path;
        await nextTick();
        element.scrollIntoView({ block: `center`, behavior: `smooth` });
        // A real action button, not the command's OS tabs or its copy button, which come first in a command lane.
        (element.querySelector<HTMLElement>(`.p-button:not([disabled])`) ?? element).focus({ preventScroll: true });
    },
    { immediate: true, flush: `post` },
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
                        tier="quiet" tone="danger"
                        :disabled="busy"
                        :loading="busy && decidedAt === `step`"
                        @click="reject"
                    >
                        <template #icon><Icon name="times" /></template>
                    </Button>
                </div>
                <p v-else class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.onlySandboxOwnerApprove`) }}</p>
            </template>

            <!-- The rebuild, or the sentence standing in for it: the banner's link lands here, so it is never empty.
                 Focusable itself for the lanes that are a sentence, so arriving on one is read out rather than lost. -->
            <div v-if="route" :id="REBUILD_ANCHOR" ref="rebuildStep" tabindex="-1" class="flex flex-col gap-2 outline-none">
                <!-- Both waiting: deciding first folds the proposal into the one rebuild, so the order is said, and the
                     rebuild below drops a tier. -->
                <p v-if="proposal && pending" class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.decideFirst`) }}</p>
                <!-- The platform builds it, for the sandbox's owner alone (sandbox.routes.ts `hostedRebuild`): a maintainer, who
                     may approve the change above, still sees the build with no button rather than one answered "sandbox not found". -->
                <HostedRebuild
                    v-if="route === `hosted` && pending && hosted"
                    :sandbox-id="hosted"
                    :hash="pending.hash"
                    :content="pending.content"
                    :text="proposal !== undefined"
                />
                <p v-else-if="route === `owner-only`" class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.onlySandboxOwnerRebuild`) }}</p>
                <p v-else-if="route === `server`" class="text-2xs text-subtle">
                    {{ t(`sandbox.environmentCard.appliesOnNext`) }}
                    <span class="font-mono">intentic deploy apply</span>
                    {{ t(`sandbox.environmentCard.againstSandboxsHost`) }}
                </p>
                <!-- The checkout rebuild itself is on the Sandbox tab; this only points there. -->
                <p v-else-if="route === `checkout`" data-executor="checkout" class="text-2xs text-subtle">
                    {{ t(`sandbox.environmentCard.buildsWithCheckoutRebuild`) }}
                    <RouterLink to="/sandbox" class="font-medium text-link hover:underline">{{ t(`sandbox.environmentCard.sandboxTab`) }}</RouterLink>
                </p>
                <!-- `bare`: no paragraph under the button, since its confirmation says what the rebuild costs; the class
                     puts back the column `bare` drops, so a running log keeps its gap. -->
                <HostRecreate
                    v-else-if="route === `device` && pending && slug"
                    :slug="slug"
                    :hash="pending.hash"
                    action="Rebuild"
                    bare
                    :text="proposal !== undefined"
                    class="flex flex-col gap-2"
                />
                <!-- A container the installer did not start: nothing here can rebuild it, and the recipe is what to take. -->
                <p v-else-if="route === `elsewhere`" class="text-xs text-content">{{ t(`sandbox.environmentCard.noRebuildHere`) }}</p>
                <!-- Contents says something arrives with a rebuild, yet nothing approved is waiting to be built. -->
                <p v-else-if="route === `nothing-pending`" class="text-xs text-content">
                    {{
                        proposal
                            ? t(`sandbox.environmentCard.nothingToRebuildDecide`)
                            : t(`sandbox.environmentCard.nothingToRebuild`, { names: arriving.map((item) => item.name).join(`, `) })
                    }}
                </p>
            </div>

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
                @decide="(tool, decision) => decide(`installs`, () => sandboxRaw(`POST /environment/runtime-install`, { input: { tool, decision } }))"
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
