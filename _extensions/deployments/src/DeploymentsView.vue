<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import type { DeployAction, DeployResource, DeployServer } from "./contract";
import {
    Button,
    ui,
    StatusTally,
    Icon,
    Notice,
    noticeOf,
    Page,
    PageAction,
    PageHeader,
    RowGroup,
    type AgentRunChoice,
    type TallyItem,
} from "@intentic/extension-ui";
import { computed, onMounted, ref, toRef } from "vue";
import { markDeploymentsSeen } from "./attention";
import DeploymentsSkeleton from "./DeploymentsSkeleton.vue";
import { incidents, topTier } from "./incidents";
import RepoLinkRow from "./RepoLinkRow.vue";
import ResourceRow from "./ResourceRow.vue";
import ServerMeta from "./ServerMeta.vue";
import { INCIDENT_TONE } from "./stateVisual";
import IncidentRow from "./IncidentRow.vue";
import { useDeploymentBoard } from "./useDeploymentBoard";

// Is what's running healthy, and what changed, a different question from Live status's drift-against-declared-state;
// gated on the Komodo connection rather than a repo. Reading order is worst-first:
// 1. the incident strip
// 2. one tally on the title row
// 3. resources grouped by host
// 4. the repo → stack mapping (setup, not operations)

const props = defineProps<{ capability?: string }>();
// Rail passes the capability id via props; a directly-mounted view with none falls back to the default id.
const capability = computed(() => props.capability ?? `komodo`);
const { board, error, isPending, act, link, logs, fix, refetch } = useDeploymentBoard(toRef(capability));

// Opening the view counts as reading it; only on mount, or a background poll would swallow a new breakage.
onMounted(() => void markDeploymentsSeen(capability.value));

const open = computed(() => topTier(incidents(board.value?.alerts ?? [])));
// topTier returns one tier; undefined when nothing is open, which also hides the strip.
const worst = computed(() => open.value[0]?.tone);
const resources = computed(() => board.value?.resources ?? []);
const servers = computed(() => board.value?.servers ?? []);
const repos = computed(() => board.value?.repos ?? []);
const stackNames = computed(() => resources.value.filter((resource) => resource.kind === `stack`).map((resource) => resource.name));

// Links to Komodo's stacks list: the level this view is really about, same route family as each row's link.
const stacksUrl = computed(() => (board.value === undefined ? undefined : `${board.value.komodoUrl}/stacks`));

// Empty resources doesn't mean an empty Komodo: a permission-less key gets an empty array from Komodo too. `viewer`
// absent might just mean an older daemon, so that gets its own case rather than assuming emptiness.
const emptyReason = computed(() => {
    if (resources.value.length > 0 || board.value === undefined || !board.value.reachable) {
        return undefined;
    }
    const viewer = board.value.viewer;
    if (viewer === undefined) {
        return {
            title: `Komodo returned nothing`,
            detail:
                `Nothing came back for this connection. If you expect stacks or deployments here, the usual cause is that the API key's ` +
                `user has no permissions on them: Komodo answers every list with nothing rather than refusing. Check the key's user in ` +
                `Komodo, or use one made on an admin account.`,
        };
    }
    if (!viewer.admin) {
        return {
            title: `This API key can't see anything in Komodo`,
            detail:
                `The key acts as "${viewer.username}", which is not an admin and has no permissions on any resource, so Komodo answers ` +
                `every list with nothing. Grant that user access in Komodo (Settings → Users → ${viewer.username}), or replace the key ` +
                `with one made on an admin account.`,
        };
    }
    return { title: `Komodo has no stacks or deployments yet`, detail: `Once you add one there, it appears here.` };
});

// Orientation tally: `running` always shows, even at zero, since an entirely silent tally reads as broken; the other
// three stay hidden until there's something to say.
const counts = computed<TallyItem[]>(() => {
    const tally = { running: 0, stopped: 0, unhealthy: 0, updates: 0 };
    for (const resource of resources.value) {
        if (resource.state === `running`) {
            tally.running++;
        } else if (resource.state === `unhealthy`) {
            tally.unhealthy++;
        } else if (resource.state === `stopped`) {
            tally.stopped++;
        }
        if (resource.updateAvailable) {
            tally.updates++;
        }
    }
    return [
        { label: `unhealthy`, value: tally.unhealthy, variant: `danger` },
        { label: `running`, value: tally.running, variant: `success`, always: true },
        { label: `stopped`, value: tally.stopped, variant: `neutral` },
        { label: tally.updates === 1 ? `update available` : `updates available`, value: tally.updates, variant: `info` },
    ];
});

// Host groups, then anything Komodo hasn't placed; an unknown-server resource must still appear on the board.
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
        ...[...byServer.entries()].filter(([name]) => !known.has(name)).map(([name, list]) => ({ label: name, server: undefined, resources: list })),
    ];
});

// An empty host gets one row, not a full section, or several empty hosts read as walls of "nothing deployed".
const carrying = computed(() => groups.value.filter((group) => group.resources.length > 0));
const idle = computed(() => groups.value.flatMap((group) => (group.resources.length === 0 && group.server !== undefined ? [group.server] : [])));

// Row currently mid-action; its buttons disable without freezing the rest of the board.
const busyId = ref<string | undefined>(undefined);
const logsFor = ref(new Map<string, { stdout: string; stderr: string }>());
const logsPendingId = ref<string | undefined>(undefined);

// Failures keyed by what failed (resource id, repo dir, incident id) so each shows beside the button that caused it,
// not as a page-wide banner. Komodo's own refusal reaches the operator via the daemon's BAD_GATEWAY passthrough.
const failures = ref(new Map<string, string>());
const clearFailure = (key: string): void => {
    const next = new Map(failures.value);
    next.delete(key);
    failures.value = next;
};
const recordFailure = (key: string, cause: unknown): void => {
    failures.value = new Map(failures.value).set(key, errorMessage(cause));
};

const runAction = async (resource: DeployResource, action: DeployAction): Promise<void> => {
    busyId.value = resource.id;
    clearFailure(resource.id);
    try {
        await act.mutateAsync({ resource, action });
    } catch (cause) {
        recordFailure(resource.id, cause);
    } finally {
        busyId.value = undefined;
    }
};

const loadLogs = async (resource: DeployResource): Promise<void> => {
    logsPendingId.value = resource.id;
    clearFailure(resource.id);
    try {
        logsFor.value = new Map(logsFor.value).set(resource.id, await logs.mutateAsync(resource));
    } catch (cause) {
        recordFailure(resource.id, cause);
    } finally {
        logsPendingId.value = undefined;
    }
};

// `key` is where the failure lands: the row if the click came from the board, the incident if from the strip.
const askAgent = async (resource: DeployResource, key: string, pick?: AgentRunChoice | undefined): Promise<void> => {
    busyId.value = resource.id;
    clearFailure(key);
    try {
        const { conversationId } = await fix.mutateAsync({ resource, pick });
        // The conversation id is the fleet card id, so this lands the board on the card that just started.
        window.location.assign(`/agents?focus=${encodeURIComponent(conversationId)}`);
    } catch (cause) {
        recordFailure(key, cause);
    } finally {
        busyId.value = undefined;
    }
};

// Resolves the alert's named resource, when it's on the board, for the incident strip's fix button.
const resourceFor = (name: string | undefined): DeployResource | undefined =>
    name === undefined ? undefined : resources.value.find((resource) => resource.name === name);

const linking = ref<string | undefined>(undefined);
const setLink = async (repo: string, stack: string): Promise<void> => {
    linking.value = repo;
    clearFailure(repo);
    try {
        await link.mutateAsync({ repo, stack });
    } catch (cause) {
        recordFailure(repo, cause);
    } finally {
        linking.value = undefined;
    }
};
</script>

<template>
    <!-- No nested scroller: it breaks `scroll-margin` and `:target`, and loses the reader's place on remount. -->
    <Page width="wide">
        <PageHeader title="Deployments">
            <!-- Hidden while the first read is in flight: "0 running" would be a claim the list is about to contradict. -->
            <template #info>
                <StatusTally
                    v-if="!isPending && board?.reachable && resources.length > 0"
                    :items="counts"
                    class="ml-2"
                />
            </template>
            <template #actions>
                <PageAction v-if="stacksUrl !== undefined" icon="box" label="Open Komodo stacks" :href="stacksUrl" />
            </template>
        </PageHeader>

        <!-- A poll failure with a board already shown; small, since the rows below are still the last good answer. -->
        <Notice v-if="error && board !== undefined" :of="noticeOf(error)" class="mb-4" />

        <!-- Nothing back yet, including while the handshake still gates the fetch; shows the board's shape, not text. -->
        <DeploymentsSkeleton v-if="isPending" />

        <!-- Daemon call failed outright (old daemon, dropped connection); its own branch, not the empty-board case. -->
        <!-- Title, cause, and the one action: the three parts <Notice> expects, in the app's order and wording. -->
        <Notice
            v-else-if="board === undefined"
            :of="{
                tone: `danger`,
                title: `Couldn't load this Komodo connection`,
                detail: error ?? `The sandbox did not answer.`,
                action: { label: `Try again`, run: () => void refetch() },
            }"
        />

        <!-- Warning, not error: not seeing Komodo isn't the same as it being down; red would cry wolf on every blip. -->
        <Notice
            v-else-if="!board.reachable"
            class="px-4 py-3"
            :of="{
                tone: `warning`,
                title: `Can't reach Komodo at ${board.komodoUrl}`,
                detail: `Nothing below is current, this is not a report that your deployments are down, only that we couldn't ask.`,
            }"
        >
            <div v-if="board.unreachableReason" class="mt-2 font-mono text-2xs">{{ board.unreachableReason }}</div>
            <Button class="mt-3" label="Try again" size="small" severity="secondary" @click="refetch()" />
        </Notice>

        <template v-else>
            <!-- 1. Needs you: only when something is open; the one boxed panel, so its frame reads as the alarm. -->
            <div v-if="worst" class="mb-6 rounded-lg border px-4 py-3" :class="INCIDENT_TONE[worst].panel">
                <div class="flex items-center gap-2">
                    <Icon name="exclamation-circle" class="text-sm" :class="INCIDENT_TONE[worst].text" />
                    <span class="text-sm font-semibold text-content">Needs you</span>
                </div>
                <div class="mt-2 flex flex-col gap-2">
                    <IncidentRow
                        v-for="incident in open"
                        :key="incident.alert.id"
                        :incident="incident"
                        :resource="resourceFor(incident.alert.resource)"
                        :failure="failures.get(incident.alert.id)"
                        @fix="(resource, pick) => askAgent(resource, incident.alert.id, pick)"
                    />
                </div>
            </div>

            <div class="flex flex-col gap-6">
                <div v-if="emptyReason" :class="ui.emptyState(`text-left`)">
                    <div class="font-medium text-content">{{ emptyReason.title }}</div>
                    <div class="mt-1">{{ emptyReason.detail }}</div>
                </div>

                <!-- ---- 3. Grouped by host ---- -->
                <template v-else>
                    <RowGroup v-for="group in carrying" :key="group.label" :label="group.label">
                        <template #info>
                            <ServerMeta v-if="group.server" :server="group.server" />
                        </template>

                        <ResourceRow
                            v-for="resource in group.resources"
                            :key="resource.id"
                            :resource="resource"
                            :busy="busyId === resource.id"
                            :logs="logsFor.get(resource.id)"
                            :logs-pending="logsPendingId === resource.id"
                            :error="failures.get(resource.id)"
                            @act="runAction"
                            @logs="loadLogs"
                            @fix="(resource, pick) => askAgent(resource, resource.id, pick)"
                        />
                    </RowGroup>

                    <!-- Empty hosts: one shared list, still carrying the state and gauges that make an empty box worth knowing. -->
                    <RowGroup v-if="idle.length > 0" label="Other hosts" caption="Connected to this Komodo with nothing deployed on them.">
                        <div v-for="server in idle" :key="server.id" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
                            <span class="text-sm font-medium text-content">{{ server.name }}</span>
                            <ServerMeta :server="server" class="ml-auto" />
                        </div>
                    </RowGroup>
                </template>

                <!-- 4. Your repos: setup, not operations; still renders with no resources, since that's when it matters most. -->
                <RowGroup v-if="repos.length > 0" label="Your repos" caption="Which Komodo stack each repo in this workspace deploys to.">
                    <RepoLinkRow
                        v-for="repoLink in repos"
                        :key="repoLink.repo"
                        :link="repoLink"
                        :stacks="stackNames"
                        :busy="linking === repoLink.repo"
                        :error="failures.get(repoLink.repo)"
                        @link="setLink"
                    />
                </RowGroup>
            </div>
        </template>
    </Page>
</template>
