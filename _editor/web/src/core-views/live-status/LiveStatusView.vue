<script setup lang="ts">
import { ResourceGroupSchema, type Deployment } from "@intentic/api-contract";
import { Button, Card, ui, CopyButton, InfoHint, Notice, type NoticeModel, Page, PageAction, PageHeader, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, reactive, ref } from "vue";
import PlanStepRow from "../../components/PlanStepRow.vue";
import { convergedBadge, type PlanOrphan, type PlanStep, readPlanSteps, statusDot, statusLabel } from "../../features/extensions/reconcileStatus";
import { groupAccent } from "../../features/extensions/resourceVisual";
import { reveal } from "../../features/capabilities/connect/useSecrets";
import { sandboxRequest } from "../../features/sandbox/client/sandboxClient";
import { jsonBody } from "../../features/sandbox/client/jsonBody";
import { useDeployments } from "../../features/extensions/useDeployments";
import { useWorkspaceState } from "../../features/extensions/useWorkspaceState";
import { useRole } from "../../features/sandbox/secrets/useRole";
import DependencyGraph from "./DependencyGraph.vue";
import ResourceDetails from "./ResourceDetails.vue";

// Plan-vs-reality board. Left: Planned, the resolved desired-state dependency graph, nodes colored by last
// reconcile status. Right: Running now, live Komodo deployments plus an on-demand live check that streams
// `intentic deploy plan` to report per-resource drift. Read-only.

const { state, error: wsError, isLoading: wsLoading, refetch: refetchState } = useWorkspaceState();
// Bare messages from the two queries below; this page knows what each was for and writes the sentence.
const wsNotice = computed<NoticeModel | undefined>(() =>
    wsError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read this workspace's state.`, detail: wsError.value },
);
const { deployments, komodoReachable, error: appsError, isLoading: appsLoading, refetch: refetchDeployments } = useDeployments();
const appsNotice = computed<NoticeModel | undefined>(() =>
    appsError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list what's running.`, detail: appsError.value },
);

// Shared with the dependency graph: selecting a node highlights its matching actual-state card.
const selectedId = ref<string | undefined>(undefined);
const selectedNode = computed(() => state.value?.resources.find((r) => r.id === selectedId.value));

// Live `intentic deploy plan` stream state.
const checking = ref(false);
const liveRan = ref(false);
const liveError = ref<NoticeModel | null>(null);
const liveActions = ref<PlanStep[]>([]);
const liveOrphans = ref<PlanOrphan[]>([]);

const loading = computed(() => wsLoading.value || appsLoading.value || checking.value);

const convergence = computed(() => convergedBadge(state.value?.converged));

// Streams the in-sandbox `intentic deploy plan` (read+diff, no apply); a failed run throws kind:"error",
// caught here as liveError.
const runLiveCheck = async (): Promise<void> => {
    if (checking.value) {
        return;
    }
    checking.value = true;
    liveError.value = null;
    liveActions.value = [];
    liveOrphans.value = [];
    try {
        const response = await sandboxRequest(`/intentic`, jsonBody(`POST`, { args: [`deploy`, `plan`] }));
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `Could not run a live check (${response.status}).`);
        }
        const { steps, orphans } = await readPlanSteps(response.body);
        liveActions.value = steps;
        liveOrphans.value = orphans;
        liveRan.value = true;
    } catch (err) {
        liveError.value = noticeFrom(err, `Live check failed.`);
    } finally {
        checking.value = false;
    }
};

const refresh = async (): Promise<void> => {
    await Promise.all([refetchState(), refetchDeployments(), runLiveCheck()]);
};

// Env keys with their non-secret value; blanked values (secrets/refs) show the key alone.
const envList = (deployment: Deployment): { key: string; label: string }[] =>
    Object.entries(deployment.env).map(([key, value]) => ({ key, label: value === `` ? key : `${key}=${value}` }));

// Provisioned-services access: URLs + admin logins from the last apply. A generated password's value is
// fetched on click via the daemon's operating-tier reveal; lower roles see the secret's name.
const { canShip: canOperate } = useRole();
const access = computed(() => state.value?.access ?? []);
const revealedAccess = reactive(new Map<string, string>());
const accessError = ref<NoticeModel | undefined>(undefined);
const toggleAccessReveal = async (key: string): Promise<void> => {
    accessError.value = undefined;
    if (revealedAccess.has(key)) {
        revealedAccess.delete(key);
        return;
    }
    try {
        revealedAccess.set(key, await reveal(key));
    } catch (err) {
        accessError.value = noticeFrom(err, `Could not reveal the password.`);
    }
};
</script>

<template>
    <div class="scrollbar-thin h-full min-h-0 overflow-auto">
        <Page width="full">
            <PageHeader title="Live status">
                <template #info>
                    <InfoHint label="Live status">
                        <span class="block text-sm font-medium text-content">Live status</span>
                        <span class="mt-1 block text-xs text-muted">
                            <b>Planned</b> is what your configuration resolves to. <b>Running now</b> is what's really on your server. When they
                            match, you're <b>up to date</b>.
                        </span>
                    </InfoHint>
                    <StatusBadge v-if="convergence" :variant="convergence.variant" :label="convergence.label" dot />
                </template>
                <template #actions>
                    <PageAction quiet icon="refresh" label="Refresh" hint="Re-read the live cluster state" :disabled="loading" @click="refresh" />
                </template>
            </PageHeader>

            <Notice v-if="wsNotice" :of="wsNotice" class="mb-4" />

            <!--
                Engine declared but down on a previously-applied setup: "Not deployed" below is meaningless until it's
                back.
            -->
            <div
                v-if="komodoReachable === false && state?.converged !== undefined"
                class="mb-4 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning"
            >
                <Icon name="exclamation-triangle" class="shrink-0" />
                <span>Your deployment engine (Komodo) is unreachable on your server: live states below reflect desired config only.</span>
            </div>

            <div class="flex flex-col gap-4">
                <!-- TOP, desired state: the dependency graph, nodes colored by their last reconcile status. -->
                <section class="rounded-lg border border-line bg-card p-4">
                    <h3 :class="ui.sectionLabel('mb-3 flex items-center gap-2')">
                        Planned
                        <InfoHint label="Graph legend">
                            <span class="block text-xs font-medium text-content">Category</span>
                            <ul class="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                <li v-for="g in ResourceGroupSchema.options" :key="g" class="flex items-center gap-1.5">
                                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" :class="groupAccent(g).bar"></span>
                                    <span class="capitalize text-muted">{{ g }}</span>
                                </li>
                            </ul>
                            <span class="mt-3 block text-xs font-medium text-content">Status</span>
                            <ul class="mt-1 flex flex-col gap-1 text-xs">
                                <li v-for="s in ['noop', 'create', 'update', 'delete', 'unknown']" :key="s" class="flex items-center gap-1.5">
                                    <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="statusDot(s)"></span>
                                    <span class="text-muted">{{ statusLabel(s) }}</span>
                                </li>
                            </ul>
                        </InfoHint>
                    </h3>
                    <DependencyGraph :resources="state?.resources ?? []" v-model="selectedId" />
                    <ResourceDetails
                        v-if="selectedNode"
                        :resource="selectedNode"
                        :resources="state?.resources ?? []"
                        :deployments="deployments"
                        v-model="selectedId"
                    />
                </section>

                <!-- BOTTOM, actual state: live Komodo deployments plus an on-demand live `intentic deploy plan` read. -->
                <section class="rounded-lg border border-line bg-card p-4">
                    <h3 :class="ui.sectionLabel('mb-3 flex items-baseline gap-2')">Running now</h3>

                    <Notice v-if="appsNotice" :of="appsNotice" class="mb-3" />

                    <div class="flex flex-col gap-2">
                        <Card
                            v-for="d in deployments"
                            :key="d.name"
                            class="flex flex-col gap-2"
                            :class="d.name === selectedId ? 'ring-1 ring-link' : ''"
                        >
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <div class="flex items-center gap-2">
                                        <span class="truncate font-medium text-content">{{ d.name }}</span>
                                        <StatusBadge
                                            :variant="d.live ? 'success' : 'neutral'"
                                            :label="d.live ? 'Live' : 'Not deployed'"
                                            size="xs"
                                            dot
                                        />
                                    </div>
                                    <p class="mt-0.5 truncate font-mono text-2xs text-subtle">{{ d.image }}</p>
                                </div>
                                <div class="flex shrink-0 items-center gap-2">
                                    <Button
                                        v-if="d.url"
                                        as="a"
                                        label="Open"
                                        size="small"
                                        severity="secondary"
                                        :href="d.url"
                                        target="_blank"
                                        rel="noopener"
                                    >
                                        <template #icon><Icon name="external-link" /></template>
                                    </Button>
                                    <Button
                                        v-if="d.komodoDeploymentUrl"
                                        as="a"
                                        label="Komodo"
                                        size="small"
                                        :text="true"
                                        :href="d.komodoDeploymentUrl"
                                        target="_blank"
                                        rel="noopener"
                                    >
                                        <template #icon><Icon name="cog" /></template>
                                    </Button>
                                </div>
                            </div>
                            <div v-if="envList(d).length > 0" class="flex flex-wrap gap-1">
                                <span
                                    v-for="item in envList(d)"
                                    :key="item.key"
                                    class="rounded bg-overlay px-1.5 py-0.5 font-mono text-2xs text-subtle"
                                >
                                    {{ item.label }}
                                </span>
                            </div>
                        </Card>
                        <p v-if="deployments.length === 0 && !appsLoading" class="py-6 text-center text-sm text-muted">
                            No live deployments yet. Wire an app in your intent and provision to see it here.
                        </p>
                    </div>

                    <!--
                        Live check: streams "intentic deploy plan" to diff the desired graph against live
                        infrastructure.
                    -->
                    <div class="mt-4 border-t border-line-subtle pt-3">
                        <div class="mb-2 flex items-center gap-2">
                            <h3 class="text-2xs font-semibold uppercase tracking-wide text-subtle/70">Live check</h3>
                            <template v-if="checking">
                                <Icon name="spinner" class="text-2xs text-info" spin />
                                <span class="text-2xs text-subtle">Reading live infrastructure…</span>
                            </template>
                        </div>
                        <Notice v-if="liveError" :of="liveError" />
                        <div v-else-if="liveRan && !checking" class="flex flex-col gap-1.5">
                            <PlanStepRow v-for="item in liveActions" :key="item.id" :id="item.id" :action="item.action" :reason="item.reason" />
                            <p v-if="liveActions.length === 0" class="text-2xs text-subtle">No resources read.</p>
                            <p v-if="liveOrphans.length > 0" class="mt-1 text-2xs text-danger">
                                Orphans (live but not in intent): {{ liveOrphans.map((orphan) => orphan.id).join(", ") }}
                            </p>
                        </div>
                        <p v-else-if="!checking" class="text-2xs text-subtle">Refresh to read the live state of your infrastructure.</p>
                    </div>
                </section>

                <!--
                    Access: URLs + admin logins for what's provisioned. Generated passwords reveal on click (owner
                    only).
                -->
                <section v-if="access.length > 0" class="rounded-lg border border-line bg-card p-4">
                    <h3 :class="ui.sectionLabel('mb-3')">Access</h3>
                    <Notice v-if="accessError" :of="accessError" class="mb-2" />
                    <div class="flex flex-col gap-2">
                        <div v-for="entry in access" :key="entry.id" class="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="font-medium text-content">{{ entry.label }}</span>
                                <a
                                    :href="entry.url"
                                    target="_blank"
                                    rel="noreferrer"
                                    class="inline-flex items-center gap-1 font-mono text-xs text-link hover:underline"
                                >
                                    {{ entry.url }} <Icon name="external-link" class="text-2xs" />
                                </a>
                            </div>
                            <div
                                v-if="entry.username !== undefined || entry.password !== undefined"
                                class="flex flex-wrap items-center gap-3 text-xs text-muted"
                            >
                                <span v-if="entry.username !== undefined"
                                    >user: <span class="font-mono text-content">{{ entry.username }}</span></span
                                >
                                <template v-if="entry.password !== undefined">
                                    <template v-if="entry.password.source === `generated` && canOperate">
                                        <span v-if="revealedAccess.has(entry.password.key)" class="inline-flex items-center gap-1">
                                            password: <span class="font-mono text-content">{{ revealedAccess.get(entry.password.key) }}</span>
                                            <CopyButton :text="revealedAccess.get(entry.password.key) ?? ``" />
                                        </span>
                                        <Button
                                            :label="revealedAccess.has(entry.password.key) ? `Hide password` : `Reveal password`"
                                            size="small"
                                            severity="secondary"
                                            :text="true"
                                            @click="toggleAccessReveal(entry.password.key)"
                                        >
                                            <template #icon><Icon :name="revealedAccess.has(entry.password.key) ? `eye-slash` : `eye`" /></template>
                                        </Button>
                                    </template>
                                    <span v-else
                                        >password: your <span class="font-mono text-content">{{ entry.password.key }}</span> secret</span
                                    >
                                </template>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </Page>
    </div>
</template>
