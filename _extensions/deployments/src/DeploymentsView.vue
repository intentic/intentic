<script setup lang="ts">
import type { DeployAction, DeployResource, DeployServer } from "@intentic/sandbox-contract";
import { Button, cmp, CountBar, type CountItem, Icon, InfoHint, Page, PageHeader, RowGroup, timeAgo } from "@intentic/extension-ui";
import { computed, onMounted, ref, toRef } from "vue";
import { markDeploymentsSeen } from "./attention";
import DeploymentsSkeleton from "./DeploymentsSkeleton.vue";
import { incidents, topTier } from "./incidents";
import RepoLinkRow from "./RepoLinkRow.vue";
import ResourceRow from "./ResourceRow.vue";
import ServerMeta from "./ServerMeta.vue";
import { INCIDENT_TONE } from "./stateVisual";
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
 *   2. one tally line — "is anything wrong right now", before you read anything else
 *   3. the list GROUPED BY SERVER — the highest-value framing call in the design. The question at 2am is
 *      "is this one app, or is it the box?", and grouping by host answers it in the layout rather than making
 *      the operator correlate it. Komodo's own UI groups by resource type, which reads worst exactly here.
 *   4. the repo → stack mapping, which is SETUP rather than operations and so goes under the thing you came for
 *
 * ONE BORDER PER GROUP, NOT PER ROW. Every level of this page used to draw its own box: a <RowGroup> surface
 * per host, a card per resource inside it, a card per repo, a framed pill around the tally — nested rectangles
 * all the way down, until a border said nothing except "something is here". <RowGroup> already owns the
 * surface and the hairlines between its children, so its children are plain rows and the page is quiet enough
 * that the one panel that IS boxed — the incident strip — reads as the alarm it is.
 */

const props = defineProps<{ capability?: string }>();
// The rail passes the capability id through the activation's props; a directly-mounted view with none falls
// back to the conventional default id, which is what a single connection is named.
const capability = computed(() => props.capability ?? `komodo`);
const { board, error, isPending, act, link, logs, fix, fixModelLabel, refetch } = useDeploymentBoard(toRef(capability));

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
const repos = computed(() => board.value?.repos ?? []);
const stackNames = computed(() => resources.value.filter((resource) => resource.kind === `stack`).map((resource) => resource.name));

/* WHY AN EMPTY BOARD IS NOT AUTOMATICALLY AN EMPTY KOMODO.
 *
 * Komodo filters every list by the caller's permissions, so an API key minted on a service user with no grants
 * gets 200 and an empty array — byte-identical to a Komodo with nothing deployed. This view shipped once
 * saying "no stacks or deployments yet" to someone whose Komodo had four stacks, which is the worst kind of
 * wrong: confidently, and about the one thing they came here to check. `viewer` is what tells the two apart.
 *
 * THREE cases, not two, because `viewer` can be absent for a second reason: a daemon older than the field.
 * Claiming an empty Komodo on that evidence would reintroduce the same confident wrong answer through the
 * back door, so the unknown case says what it knows and points at the thing the owner can actually check. */
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
                `user has no permissions on them — Komodo answers every list with nothing rather than refusing. Check the key's user in ` +
                `Komodo, or use one made on an admin account.`,
        };
    }
    if (!viewer.admin) {
        return {
            title: `This API key can't see anything in Komodo`,
            detail:
                `The key acts as "${viewer.username}", which is not an admin and has no permissions on any resource — so Komodo answers ` +
                `every list with nothing. Grant that user access in Komodo (Settings → Users → ${viewer.username}), or replace the key ` +
                `with one made on an admin account.`,
        };
    }
    return { title: `Komodo has no stacks or deployments yet`, detail: `Once you add one there, it appears here.` };
});

// The orientation line. `running` renders at zero because a tally that is entirely silent reads as a broken
// view; the other three are news or nothing, so they stay out of the way until there is something to say.
const counts = computed<CountItem[]>(() => {
    const tally = { running: 0, stopped: 0, unhealthy: 0, updates: 0 };
    for (const resource of resources.value) {
        if (resource.state === `running`) tally.running++;
        else if (resource.state === `unhealthy`) tally.unhealthy++;
        else if (resource.state === `stopped`) tally.stopped++;
        if (resource.updateAvailable) tally.updates++;
    }
    return [
        { label: `unhealthy`, value: tally.unhealthy, variant: `danger` },
        { label: `running`, value: tally.running, variant: `success`, always: true },
        { label: `stopped`, value: tally.stopped, variant: `neutral` },
        { label: tally.updates === 1 ? `update available` : `updates available`, value: tally.updates, variant: `info` },
    ];
});

// Grouped by host, then anything Komodo has not placed. A resource whose server we do not know still has to
// appear — during an incident, a row missing from the board is the worst outcome.
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

/* THE BOARD IS THE HOSTS THAT CARRY SOMETHING; the rest are one list at the bottom.
 *
 * A Komodo with three registered-but-empty boxes used to render three consecutive sections whose entire
 * content was the sentence "Nothing deployed on this host" inside a full-width panel — three loud ways to say
 * nothing, pushing the only group with containers in it under the fold, in a view whose reason for existing is
 * that something may be wrong right now.
 *
 * An empty host is still worth listing: it is where a container is MISSING from, and its own state and disk
 * are facts. So it keeps its state badge and its gauges — it just does that as one row among its peers rather
 * than as a section of its own. The unplaced bucket never lands here, since it only exists when it has rows. */
const carrying = computed(() => groups.value.filter((group) => group.resources.length > 0));
const idle = computed(() => groups.value.flatMap((group) => (group.resources.length === 0 && group.server !== undefined ? [group.server] : [])));

// Which row is mid-action, so its buttons disable without freezing the whole board.
const busyId = ref<string | undefined>(undefined);
const logsFor = ref(new Map<string, { stdout: string; stderr: string }>());
const logsPendingId = ref<string | undefined>(undefined);

/* Failures, keyed by the thing that failed — a resource id, a repo dir, an incident id.
 *
 * Komodo's own words reach the operator because the daemon passes a refusal through as BAD_GATEWAY precisely
 * so this can say WHY rather than "something went wrong". What it may NOT do is say it at the top of the page:
 * a 500 about one stack rendered as a full-width red slab above a board of forty rows, hundreds of pixels from
 * the button that caused it and giving no clue which row it was about. An action's refusal belongs beside the
 * button that asked for it. */
const failures = ref(new Map<string, string>());
const clearFailure = (key: string): void => {
    const next = new Map(failures.value);
    next.delete(key);
    failures.value = next;
};
const recordFailure = (key: string, cause: unknown): void => {
    failures.value = new Map(failures.value).set(key, cause instanceof Error ? cause.message : String(cause));
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

// `key` is where a failure lands: the row when the click came from the board, the incident when it came from
// the strip — either way, next to the button that was pressed.
const askAgent = async (resource: DeployResource, key: string): Promise<void> => {
    busyId.value = resource.id;
    clearFailure(key);
    try {
        const { conversationId } = await fix.mutateAsync(resource);
        // The conversation id IS the fleet card id — land the board on the card that just started.
        window.location.assign(`/agents?focus=${encodeURIComponent(conversationId)}`);
    } catch (cause) {
        recordFailure(key, cause);
    } finally {
        busyId.value = undefined;
    }
};

// The incident strip's fix button addresses the resource the alert names, when that resource is on the board.
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
    <div class="scrollbar-thin h-full min-h-0 overflow-auto">
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

            <!-- A poll that failed while a board is already on screen. Kept at the top and kept SMALL: the rows
                 below are the last good answer and still worth reading, so this says the board has stopped
                 refreshing rather than replacing it. -->
            <div v-if="error && board !== undefined" :class="cmp.alertDanger(`mb-4 break-words`)">{{ error }}</div>

            <!-- Nothing has come back yet — including the window where the sandbox handshake still gates the
                 fetch. Show the board's shape rather than a line of text that everything then jumps under. -->
            <DeploymentsSkeleton v-if="isPending" />

            <!-- The daemon call itself failed (an old daemon with no /komodo routes, a dropped connection).
                 It gets its own branch because the alternative is what actually shipped: `board` undefined fell
                 through to the board below, whose zero resources rendered "Komodo has no stacks or deployments
                 yet" — a confident wrong answer about the one thing the reader came to check. -->
            <div v-else-if="board === undefined" :class="cmp.alertDanger(`px-4 py-3 text-sm`)">
                <div class="font-medium">Couldn't load this Komodo connection</div>
                <div class="mt-1 text-xs opacity-80">{{ error ?? `The sandbox did not answer.` }}</div>
                <Button class="mt-3" label="Try again" size="small" severity="secondary" outlined @click="refetch()" />
            </div>

            <!-- The single most important thing this view can say, and it can only say it by rendering.
                 Deliberately a WARNING and not an error: not being able to see production is not the same as
                 production being broken, and drawing it red would cry wolf on every network blip. -->
            <div v-else-if="!board.reachable" :class="cmp.alertWarning(`px-4 py-3 text-sm`)">
                <div class="font-medium">Can't reach Komodo at {{ board.komodoUrl }}</div>
                <div class="mt-1 text-xs opacity-80">
                    Nothing below is current — this is not a report that your deployments are down, only that we couldn't ask.
                </div>
                <div v-if="board.unreachableReason" class="mt-2 font-mono text-2xs opacity-70">{{ board.unreachableReason }}</div>
                <Button class="mt-3" label="Try again" size="small" severity="secondary" outlined @click="refetch()" />
            </div>

            <template v-else>
                <!-- ---- 1. Needs you ----
                     Only when something is open. This is the reason the rail badged, and it carries the
                     buttons rather than making the operator find the row. The one boxed panel on the page:
                     everything else lives on a hairline, so the frame here means "this is the alarm". -->
                <div v-if="worst" class="mb-6 rounded-lg border px-4 py-3" :class="INCIDENT_TONE[worst].panel">
                    <div class="flex items-center gap-2">
                        <Icon name="exclamation-circle" class="text-sm" :class="INCIDENT_TONE[worst].text" />
                        <span class="text-sm font-semibold text-content">Needs you</span>
                    </div>
                    <div class="mt-2 flex flex-col gap-2">
                        <div v-for="incident in open" :key="incident.alert.id" class="flex flex-col gap-1">
                            <!-- items-start, not items-center: a summary long enough to wrap ("api running →
                                 restarting on prod-1" on a phone) otherwise pushes its own dot onto a line of
                                 its own, and a bullet with nothing beside it reads as a rendering fault. -->
                            <div class="flex items-start gap-2">
                                <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="INCIDENT_TONE[incident.tone].dot"></span>
                                <span class="min-w-0 flex-1 text-sm text-content">
                                    {{ incident.summary }}
                                    <span class="whitespace-nowrap text-2xs text-subtle">{{ timeAgo(incident.alert.ts) }}</span>
                                </span>
                                <Button
                                    v-if="resourceFor(incident.alert.resource)"
                                    label="Ask the agent"
                                    class="-my-1 shrink-0"
                                    size="small"
                                    severity="secondary"
                                    text
                                    @click="askAgent(resourceFor(incident.alert.resource)!, incident.alert.id)"
                                >
                                    <template #icon><Icon name="sparkles" /></template>
                                </Button>
                            </div>
                            <div v-if="failures.get(incident.alert.id)" :class="cmp.alertDanger(`break-words`)">
                                {{ failures.get(incident.alert.id) }}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- ---- 2. Is anything wrong right now ---- -->
                <CountBar v-if="resources.length > 0" :items="counts" class="mb-5" />

                <div class="flex flex-col gap-6">
                    <div v-if="emptyReason" :class="cmp.emptyState(`text-left`)">
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
                                :fix-model-label="fixModelLabel"
                                @act="runAction"
                                @logs="loadLogs"
                                @fix="askAgent($event, $event.id)"
                            />
                        </RowGroup>

                        <!-- Hosts with nothing on them: one list, one surface, still carrying the state and
                             the gauges that make an empty box worth knowing about. -->
                        <RowGroup v-if="idle.length > 0" label="Other hosts" caption="Connected to this Komodo with nothing deployed on them.">
                            <div v-for="server in idle" :key="server.id" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
                                <span class="text-sm font-medium text-content">{{ server.name }}</span>
                                <ServerMeta :server="server" class="ml-auto" />
                            </div>
                        </RowGroup>
                    </template>

                    <!-- ---- 4. Your repos ----
                         SETUP rather than operations, so it sits under the board an operator opened this view
                         for. It still leads on a first connection, because that is exactly when the board
                         above it is one short empty-state paragraph — and it renders whether or not Komodo
                         returned resources, since a workspace with a compose file and nothing linked yet is
                         the state where this section matters most. -->
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
    </div>
</template>
