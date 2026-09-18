<script setup lang="ts">
import { EnvironmentSchema } from "@intentic/api-contract";
import { Button, Code, Notice, type NoticeModel, RowGroup, RowNote, SegmentedControl, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { ENVIRONMENT_KEY, useEnvironment } from "./useEnvironment";
import { useEnvironmentContents } from "./useEnvironmentContents";
import { useRole } from "../secrets/useRole";
import { useSandbox } from "../client/useSandbox";
import DevRebuild from "./DevRebuild.vue";
import HostedRebuild from "./HostedRebuild.vue";
import HostRecreate from "../../capabilities/connect/HostRecreate.vue";
import EnvironmentContents from "./EnvironmentContents.vue";
import RuntimeInstalls from "./RuntimeInstalls.vue";
import DiffToolbar from "../../workspace/viewers/DiffToolbar.vue";
import DiffView from "../../workspace/viewers/DiffView.vue";
import { useT } from "@intentic/ui/i18n";

// The sandbox's environment, read two ways: contents leads as the approval surface, the Dockerfile diff
// sits behind a pill. The decision (and its rebuild) sits below both views since it concerns the
// environment's state, not its display; approval pins the content's hash, and the rebuild itself runs
// outside the container (see HostRecreate).

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

// Runs only while Contents is selected (probing versions spawns processes), not gated on what ends up shown.
const { groups, loading, error: contentsError, unsupported, refresh: reprobe } = useEnvironmentContents(() => view.value === `contents`);

// Falls back to recipe when the daemon can't answer for contents; hides that tab entirely.
const shown = computed(() => (unsupported.value ? `recipe` : view.value));

// Refreshes both reads and forces a re-probe, so a newly installed tool doesn't need a restart to show up.
const load = async (): Promise<void> => {
    reprobe();
    await query.refetch();
};

// Entries not yet dismissed; a dismissed install is a decided one and no longer a reason to show this card.
const awaiting = computed(() => recurring.value.filter((entry) => entry.declined !== true));

const decide = (path: string, body?: object): Promise<void> =>
    run(async () => {
        const next = EnvironmentSchema.parse(await sandboxJson(path, jsonBody(`POST`, body ?? {})));
        queryClient.setQueryData(ENVIRONMENT_KEY, next);
    }, `Could not update the environment.`);
const approve = (): Promise<void> => decide(`/environment/approve`, { hash: proposal.value?.hash });
const reject = (): Promise<void> => decide(`/environment/reject`);
</script>

<template>
    <RowGroup v-if="proposal || pending || applied || awaiting.length" :label="t(`sandbox.environmentCard.environment`)">
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-2">
                <SegmentedControl v-if="!unsupported" v-model="view" :options="VIEWS" />
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

        <!-- `gap-5` must match the section spacing in <EnvironmentContents>, so sections keep one rhythm. -->
        <RowNote variant="block" class="flex flex-col gap-5">
            <!-- Leads in every state, including a pending proposal (incoming entries show marked as awaiting approval). -->
            <EnvironmentContents v-if="shown === `contents`" :groups="groups" :loading="loading" :error="contentsError" />

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

            <!-- Points to Update, not rebuild: an environment rebuild builds on the image already running, so it wouldn't fix an outdated image. -->
            <p v-if="unsupported" class="text-2xs text-subtle">
                {{ t(`sandbox.environmentCard.sandboxsImageOlderThan`) }}
            </p>

            <!-- Runtime installs sessions keep making, cross-session and drift-corroborated; fixable ones are usually already drafted into the proposal above. -->
            <RuntimeInstalls
                v-if="recurring.length"
                :entries="recurring"
                :can-operate="canOperate"
                :busy="busy"
                @decide="(tool, decision) => decide(`/environment/runtime-install`, { tool, decision })"
            />

            <!-- The decision, under both views: it concerns the environment's state, not how it's displayed. -->
            <template v-if="proposal">
                <div v-if="canOperate" class="flex items-center justify-end gap-2">
                    <Button :label="t(`sandbox.environmentCard.reject`)" size="small" severity="danger" :text="true" :loading="busy" @click="reject">
                        <template #icon><Icon name="times" /></template>
                    </Button>
                    <Button :label="t(`ui.action.approve`)" size="small" :loading="busy" @click="approve">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
                <p v-else class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.onlySandboxOwnerApprove`) }}</p>
            </template>

            <template v-if="pending">
                <!-- The platform builds it; owner-gated there, so a member sees the build with no button. -->
                <template v-if="hosted">
                    <HostedRebuild v-if="canOperate" :sandbox-id="hosted" :hash="pending.hash" :content="pending.content" />
                    <p v-else class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.onlySandboxOwnerRebuild`) }}</p>
                </template>
                <template v-else-if="serverManaged">
                    <p class="text-2xs text-subtle">
                        {{ t(`sandbox.environmentCard.appliesOnNext`) }}
                        <span class="font-mono">intentic deploy apply</span>
                        {{ t(`sandbox.environmentCard.againstSandboxsHost`) }}
                    </p>
                </template>
                <template v-else-if="slug">
                    <p class="text-xs font-medium text-content">{{ t(`sandbox.environmentCard.toFinishRebuildSandbox`) }}</p>
                    <HostRecreate :slug="slug" :hash="pending.hash" action="Rebuild" />
                </template>
            </template>

            <!-- A base compiled from a checkout: what a newer image contains comes from there, not from a release. On a
                 pending recipe that makes two rebuilds on one card, and the second is a SUPERSET of the first — it
                 applies the same recipe on a base it rebuilds first. That fact is told by the offer itself
                 (`recipePending`), never by a sentence under the other button, which is where a reader attaches it to
                 the wrong one. -->
            <DevRebuild
                v-if="localImage && slug && canOperate"
                :slug="slug"
                :base="localImage.base"
                :root="localImage.root"
                :recipe-pending="pending !== undefined"
            />

            <Notice v-if="actionNotice" :of="actionNotice" />
        </RowNote>
    </RowGroup>
</template>
