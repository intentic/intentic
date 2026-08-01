<script setup lang="ts">
import type { DeployAction, DeployResource, DeployServer } from "@intentic/sandbox-contract";
import { Button, cmp, Icon, InfoHint, Page, PageHeader, RowGroup, timeAgo } from "@intentic/extension-ui";
import { computed, onMounted, ref, toRef } from "vue";
import { markDeploymentsSeen } from "./attention";
import { incidents, topTier } from "./incidents";
import ResourceRow from "./ResourceRow.vue";
import { gaugeTone, INCIDENT_TONE, SERVER_TONE } from "./stateVisual";
import { useDeploymentBoard } from "./useDeploymentBoard";

/* The Deployments view: is what is running healthy, and what changed?
 *
 * That is deliberately a DIFFERENT question from the Live status core view, which asks whether reality matches
 * what you declared (drift against the desired-state repo). This one is operations, and it is gated on the
 * Komodo connection rather than on a repo, so it exists for someone who simply runs Komodo and has no
 * intentic-managed infra at all.
 *
 * Reading order is worst-first, because nothing an outage needs may sit below the fold:
 *   1. the incident strip — the reason the rail badged, with the buttons already on it
 *   2. one summary line — "is anything wrong right now", before you read anything else
 *   3. the list GROUPED BY SERVER — the highest-value framing call in the design. The question at 2am is
 *      "is this one app, or is it the box?", and grouping by host answers it in the layout rather than making
 *      the operator correlate it. Komodo's own UI groups by resource type, which reads worst exactly here.
 */

const props = defineProps<{ capability?: string }>();
// The rail passes the capability id through the activation's props; a directly-mounted view with none falls
// back to the conventional default id, which is what a single connection is named.
const capability = computed(() => props.capability ?? `komodo`);
const { board, error, isPending, act, logs, fix, refetch } = useDeploymentBoard(toRef(capability));

// Opening the view IS reading it: stamp read state so the rail stops flagging incidents now on screen. Only
// on mount — re-stamping as the board polls would swallow a breakage that lands while the tab sits in the
// background, which is exactly the one the badge exists for.
onMounted(() => void markDeploymentsSeen(capability.value));

const open = computed(() => topTier(incidents(board.value?.alerts ?? [])));
// topTier returns one tier, so the strip's colour is the first entry's — undefined when nothing is open,
// which is also what hides the strip.
const worst = computed(() => open.value[0]?.tone);
const resources = computed(() => board.value?.resources ?? []);
const servers = computed(() => board.value?.servers ?? []);

const counts = computed(() => {
    const tally = { running: 0, stopped: 0, unhealthy: 0, updates: 0 };
    for (const resource of resources.value) {
        if (resource.state === `running`) tally.running++;
        else if (resource.state === `unhealthy`) tally.unhealthy++;
        else if (resource.state === `stopped`) tally.stopped++;
        if (resource.updateAvailable) tally.updates++;
    }
    return tally;
});

// Grouped by host, servers in their own order, then anything Komodo has not placed. A resource whose server we
// do not know still has to appear — during an incident, a row missing from the board is the worst outcome.
const UNPLACED = `Not on a server`;
interface ServerGroup {
    readonly label: string;
    readonly server: DeployServer | undefined;
    readonly resources: readonly DeployResource[];
}
const groups = computed<ServerGroup[]>(() => {
    const byServer = new Map<string, DeployResource[]>();
    for (const resource of resources.value) {
        const key = resource.server ?? UNPLACED;
        byServer.set(key, [...(byServer.get(key) ?? []), resource]);
    }
    const known = new Set(servers.value.map((server) => server.name));
    return [
        ...servers.value.map((server) => ({ label: server.name, server, resources: byServer.get(server.name) ?? [] })),
        // A resource whose host Komodo does not list still has to appear: during an incident, a row missing
        // from the board is the worst possible outcome.
        ...[...byServer.entries()].filter(([name]) => !known.has(name)).map(([name, list]) => ({ label: name, server: undefined, resources: list })),
    ];
});

const gauges = (server: DeployServer): { label: string; value: number }[] =>
    [
        { label: `cpu`, value: server.cpuPercent },
        { label: `mem`, value: server.memPercent },
        { label: `disk`, value: server.diskPercent },
    ].flatMap((gauge) => (gauge.value === undefined ? [] : [{ label: gauge.label, value: gauge.value }]));

// Which row is mid-action, so its buttons disable without freezing the whole board.
const busyId = ref<string | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);
const logsFor = ref(new Map<string, { stdout: string; stderr: string }>());
const logsPendingId = ref<string | undefined>(undefined);

const runAction = async (resource: DeployResource, action: DeployAction): Promise<void> => {
    busyId.value = resource.id;
    actionError.value = undefined;
    try {
        await act.mutateAsync({ resource, action });
    } catch (err) {
        // Komodo's own words — the daemon passes a refusal through as BAD_GATEWAY precisely so this can say
        // WHY rather than "something went wrong".
        actionError.value = err instanceof Error ? err.message : String(err);
    } finally {
        busyId.value = undefined;
    }
};

const loadLogs = async (resource: DeployResource): Promise<void> => {
    logsPendingId.value = resource.id;
    try {
        logsFor.value = new Map(logsFor.value).set(resource.id, await logs.mutateAsync(resource));
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : String(err);
    } finally {
        logsPendingId.value = undefined;
    }
};

const askAgent = async (resource: DeployResource): Promise<void> => {
    busyId.value = resource.id;
    actionError.value = undefined;
    try {
        const { conversationId } = await fix.mutateAsync(resource);
        // The conversation id IS the fleet card id — land the board on the card that just started.
        window.location.assign(`/agents?focus=${encodeURIComponent(conversationId)}`);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : String(err);
    } finally {
        busyId.value = undefined;
    }
};

// The incident strip's fix button addresses the resource the alert names, when that resource is on the board.
const resourceFor = (name: string | undefined): DeployResource | undefined =>
    name === undefined ? undefined : resources.value.find((resource) => resource.name === name);
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page width="wide">
            <PageHeader title="Deployments" description="Container health, incidents and one-click redeploys across your Komodo.">
                <template #info>
                    <InfoHint label="Deployments">
                        <span class="block text-sm font-medium text-content">Deployments</span>
                        <span class="mt-1 block text-xs text-muted">
                            Every stack and deployment on the connected Komodo, grouped by the host it runs on — so a bad box reads as a bad box
                            rather than as six unrelated outages. The rail badges an <b>incident</b>: a container that left running, a host that went
                            unreachable, a build that failed. It counts the moment things broke, not how long they have been broken, and it clears
                            when you look. <b>Ask the agent to fix</b> starts an isolated agent with the container's logs and this workspace's source.
                        </span>
                    </InfoHint>
                </template>
                <template #actions>
                    <a
                        v-if="board?.komodoUrl"
                        :href="board.komodoUrl"
                        target="_blank"
                        rel="noopener"
                        class="flex items-center gap-1 text-xs text-subtle hover:text-link"
                    >
                        Open Komodo
                        <Icon name="arrow-up-right" class="text-2xs" />
                    </a>
                </template>
            </PageHeader>

            <div v-if="error" :class="cmp.alertDanger(`mb-4 px-4 py-3 text-sm`)">{{ error }}</div>
            <div v-if="actionError" :class="cmp.alertDanger(`mb-4 px-4 py-3 text-sm`)">{{ actionError }}</div>

            <div v-if="isPending" class="text-sm text-muted">Reading your deployments…</div>

            <template v-else-if="board && !board.reachable">
                <!-- The single most important thing this view can say, and it can only say it by rendering.
                     Deliberately a WARNING and not an error: not being able to see production is not the same
                     as production being broken, and drawing it red would cry wolf on every network blip. -->
                <div :class="cmp.alertWarning(`px-4 py-3 text-sm`)">
                    <div class="font-medium">Can't reach Komodo at {{ board.komodoUrl }}</div>
                    <div class="mt-1 text-xs opacity-80">
                        Nothing below is current — this is not a report that your deployments are down, only that we couldn't ask.
                    </div>
                    <div v-if="board.unreachableReason" class="mt-2 font-mono text-2xs opacity-70">{{ board.unreachableReason }}</div>
                    <Button class="mt-3" size="small" severity="secondary" outlined @click="refetch()">Try again</Button>
                </div>
            </template>

            <template v-else>
                <!-- ---- 1. Needs you ----
                     Only when something is open. This is the reason the rail badged, and it carries the
                     buttons rather than making the operator find the row. -->
                <div v-if="worst" class="mb-5 rounded-lg border px-4 py-3" :class="INCIDENT_TONE[worst].panel">
                    <div class="flex items-center gap-2">
                        <Icon name="exclamation-circle" class="text-sm" :class="INCIDENT_TONE[worst].text" />
                        <span class="text-sm font-semibold text-content">Needs you</span>
                    </div>
                    <div class="mt-2 flex flex-col gap-1.5">
                        <div v-for="incident in open" :key="incident.alert.id" class="flex flex-wrap items-center gap-2">
                            <span class="h-2 w-2 shrink-0 rounded-full" :class="INCIDENT_TONE[incident.tone].dot"></span>
                            <span class="text-sm text-content">{{ incident.summary }}</span>
                            <span class="text-2xs text-subtle">{{ timeAgo(incident.alert.ts) }}</span>
                            <Button
                                v-if="resourceFor(incident.alert.resource)"
                                size="small"
                                severity="secondary"
                                text
                                @click="askAgent(resourceFor(incident.alert.resource)!)"
                            >
                                <Icon name="sparkles" class="mr-1" />
                                Ask the agent
                            </Button>
                        </div>
                    </div>
                </div>

                <!-- ---- 2. Is anything wrong right now ---- -->
                <div v-if="resources.length > 0" class="mb-5 flex flex-wrap items-center gap-3">
                    <div class="flex items-center gap-4 rounded-lg border border-line bg-card px-4 py-2.5">
                        <div v-if="counts.unhealthy > 0" class="flex items-center gap-1.5">
                            <span class="h-2 w-2 rounded-full bg-danger"></span>
                            <span class="text-sm font-semibold text-danger">{{ counts.unhealthy }}</span>
                            <span class="text-xs text-muted">unhealthy</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <span class="h-2 w-2 rounded-full bg-success"></span>
                            <span class="text-sm font-semibold text-success">{{ counts.running }}</span>
                            <span class="text-xs text-muted">running</span>
                        </div>
                        <div v-if="counts.stopped > 0" class="flex items-center gap-1.5">
                            <span class="h-2 w-2 rounded-full bg-subtle"></span>
                            <span class="text-sm font-semibold text-subtle">{{ counts.stopped }}</span>
                            <span class="text-xs text-muted">stopped</span>
                        </div>
                        <div v-if="counts.updates > 0" class="flex items-center gap-1.5">
                            <span class="h-2 w-2 rounded-full bg-info"></span>
                            <span class="text-sm font-semibold text-info">{{ counts.updates }}</span>
                            <span class="text-xs text-muted">updates available</span>
                        </div>
                    </div>
                </div>

                <div v-if="resources.length === 0" :class="cmp.emptyState()">
                    Komodo has no stacks or deployments yet. Once you add one there, it appears here.
                </div>

                <!-- ---- 3. Grouped by host ---- -->
                <div v-else class="flex flex-col gap-6">
                    <RowGroup v-for="group in groups" :key="group.label" :label="group.label">
                        <template #info>
                            <div v-if="group.server" class="flex flex-wrap items-center gap-3">
                                <span class="flex items-center gap-1.5">
                                    <span class="h-2 w-2 rounded-full" :class="SERVER_TONE[group.server.state].dot"></span>
                                    <span class="text-2xs" :class="SERVER_TONE[group.server.state].text">{{
                                        SERVER_TONE[group.server.state].label
                                    }}</span>
                                </span>
                                <!-- The context that explains a large share of deployment failures, free from
                                     the same list call that gave us the hosts. -->
                                <span v-for="gauge in gauges(group.server)" :key="gauge.label" class="flex items-center gap-1.5">
                                    <span class="text-2xs text-subtle">{{ gauge.label }}</span>
                                    <span class="h-1.5 w-12 overflow-hidden rounded-full bg-line">
                                        <span
                                            class="block h-full rounded-full"
                                            :class="gaugeTone(gauge.value)"
                                            :style="{ width: `${gauge.value}%` }"
                                        ></span>
                                    </span>
                                    <span class="text-2xs text-subtle">{{ gauge.value }}%</span>
                                </span>
                                <a :href="group.server.url" target="_blank" rel="noopener" class="text-2xs text-subtle hover:text-link">Komodo ↗</a>
                            </div>
                        </template>
                        <div class="flex flex-col gap-2">
                            <ResourceRow
                                v-for="resource in group.resources"
                                :key="resource.id"
                                :resource="resource"
                                :busy="busyId === resource.id"
                                :logs="logsFor.get(resource.id)"
                                :logs-pending="logsPendingId === resource.id"
                                @act="runAction"
                                @logs="loadLogs"
                                @fix="askAgent"
                            />
                            <div v-if="group.resources.length === 0" class="px-1 text-2xs text-subtle">Nothing deployed on this host.</div>
                        </div>
                    </RowGroup>
                </div>
            </template>
        </Page>
    </div>
</template>
