<script setup lang="ts">
import { hostCardOf } from "@intentic/sandbox-contract";
import {
    agentLines,
    Button,
    ConfirmDialog,
    DeviceAgentGroup,
    DeviceAgentNotes,
    DeviceDetail,
    DeviceRunLog,
    type DeviceSandboxGroup,
    Icon,
    mirroringOff,
    type ResourcesAsk,
    Row,
    RowGroup,
    RowNote,
    SandboxResourcesDialog,
    SandboxVerbs,
    StatusBadge,
    ui,
} from "@intentic/ui";
import { computed, ref } from "vue";
import { type RouteLocationRaw, RouterLink } from "vue-router";
import DeviceConcern from "./DeviceConcern.vue";
import DeviceOpFailure from "./DeviceOpFailure.vue";
import DeviceRunners from "./DeviceRunners.vue";
import { boardRoute } from "./deviceLinks";
import { deviceAgentPanel } from "./deviceAgent";
import { blockAttention, type DeviceCardFix, deviceAttention } from "./deviceAttention";
import {
    commandable,
    type DeviceRow,
    deviceState,
    deviceSwitches,
    clearable,
    deviceTone,
    fixable,
    folderOwner,
    type MachineRow,
    machineLists,
    manageable,
    managerOf,
    manySided,
    pausable,
    selfGroup,
} from "./deviceRows";
import { useDeviceOps } from "./deviceOps";
import { environmentFacts, environmentTitle, wslDistroRows } from "./machineEnvironments";
import { type ConflictAsk, conflictAsk } from "./sync/conflictAsk";
import SandboxSyncToggles from "./sync/SandboxSyncToggles.vue";
import { type DeviceScopes, deviceDoors, deviceHardware, lastSeenNote, manageBlock, osLabel, osTitle, syncNote, syncStopped } from "./deviceFacts";
import { startAgent } from "../../agents/fleet/agentActions";
import HostConnectDialog from "../../capabilities/connect/HostConnectDialog.vue";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { machineGrants } from "../../capabilities/model/connections";
import { useRole } from "../secrets/useRole";

// One machine, as a page rather than an accordion body: who it is, what it wants from you, what this
// sandbox has on it, and — last, and set apart — how to cut it off. Every button here acts on this one
// machine, so one op at a time is the whole page's rule (see deviceOps.ts). A PC connected through several
// environments (Windows and the distros on it) is still one page: its environments are rows of their own, each
// with its agent and its concerns, and its sandboxes are listed once, since one engine serves every door.

const { machine, latest, ownSlug, readAt, refetch } = defineProps<{
    machine: MachineRow;
    /** The release this sandbox knows about; undefined on a dev build or a sandbox that never reached the registry. */
    latest: string | undefined;
    ownSlug: string | undefined;
    /** When this reading landed; the machine is judged as of then, not as of now (see deviceFacts.ts). */
    readAt: number;
    refetch: () => void;
}>();

const environments = computed(() => machine.environments);
const many = computed(() => manySided(machine));
// The one device of a one-environment machine: the page reads exactly as it did before machines existed.
const lone = computed<DeviceRow | undefined>(() => (many.value ? undefined : environments.value[0]));
const ops = useDeviceOps(() => machine, refetch);

// Why a row has no buttons, read from the capability rather than discovered by a click. Looked up by CARD: an
// environment of a machine is a connection of that machine's card (`<card>::wsl:<distro>`), and the switches it is
// admitted on are the card's.
const { capabilities } = useCapabilities();
const capabilityOf = (row: DeviceRow) => {
    const hostId = row.device.hostId;
    return hostId === undefined ? undefined : capabilities.value.find((entry) => entry.id === hostCardOf(hostId));
};
const scopesOf = (row: DeviceRow): DeviceScopes | undefined => capabilityOf(row)?.config;

// Owner-only, per machine, no fleet-wide equivalent: the only path that works for a laptop that is lost,
// wiped, or someone else's. Minting this machine a fresh pairing has the same floor (the daemon refuses a
// member's), so the same answer decides whether Reconnect is offered at all.
const { isOwner } = useRole();

// The door the sandbox list's buttons go through, and what stands between it and them. On a lone device the
// block is one of its own concerns; on a many-sided machine it is drawn beside the list it is about.
const manager = computed(() => managerOf(machine) ?? environments.value[0]);
const block = computed(() => (manager.value === undefined ? undefined : manageBlock(manager.value.device, scopesOf(manager.value))));
const listBlock = computed(() =>
    many.value && manager.value !== undefined ? blockAttention(manager.value, { block: block.value, canPair: isOwner.value }) : undefined,
);

const concernsOf = (row: DeviceRow) =>
    deviceAttention(row, { block: many.value ? undefined : block.value, readAt, canPair: isOwner.value });

// The agent as its own object rather than a version printed under the name: what it serves, what it wants,
// and the two verbs that change either. Undefined only on a machine with no version and no command door.
const agentOf = (row: DeviceRow) => deviceAgentPanel(row, latest, readAt);

// The environments an agent op can actually be sent to — the same rule the row buttons are drawn from, so the
// machine-wide control offers exactly what those buttons would.
const updatable = computed(() => environments.value.filter((environment) => (agentOf(environment)?.actions.length ?? 0) > 0));

// A many-sided machine draws its environments' notes itself, outside any group of their own.
const agentLinesOf = (row: DeviceRow) => {
    const panel = agentOf(row);
    return panel === undefined ? [] : agentLines(panel);
};

// Whether an environment's agent block has anything to show: an op in flight, its log, or its answer.
const agentActivity = (row: DeviceRow): boolean =>
    ops.agentWaiting(row) !== undefined ||
    ops.agentBusy(row) ||
    ops.agentLines(row).length > 0 ||
    ops.agentFailure(row) !== undefined ||
    ops.agentOutcome(row) !== undefined;

const cardRoute = (fix: DeviceCardFix): RouteLocationRaw => {
    const card = { name: `capabilities`, params: { card: fix.card } };
    return fix.connection === undefined ? card : { ...card, query: { edit: fix.connection } };
};

// The machine's own facts, in the quietest ink: read once per device, mostly to tell two identically-named
// ones apart. The enrollment's own line joins them, since it is a fact about the machine too.
const hardware = computed(() =>
    lone.value === undefined ? `` : [...deviceHardware(lone.value.device), ...deviceDoors(lone.value.device).map((door) => door.name)].join(` · `),
);

// What the masthead says beside the name: a lone device's OS, or every environment of a many-sided machine.
const masthead = computed(() =>
    lone.value === undefined ? environments.value.map((environment) => environmentTitle(environment)).join(` · `) : osLabel(lone.value.device),
);

// The Windows side's distros, with the door this sandbox already holds into each; the way a second environment
// is connected from the page of the machine it belongs to.
const distros = computed(() => wslDistroRows(machine));

// The machine's three lists as the detail kit takes them, merged across environments.
const lists = computed(() => machineLists(environments.value));
const described = computed(() => environments.value.some((environment) => environment.device.report !== undefined || environment.device.sandboxes !== undefined));

// Reconnecting is the one remedy that doesn't travel over the machine's own socket — there isn't one — so it is a
// dialog rather than an op: it mints a fresh single-use command here for the reader to run out there. Opened from
// the sentence that explains the silence, instead of sending anyone off to find the machine's capability card.
// Held by environment key, since each environment pairs on its own.
const reconnecting = ref<string | undefined>();
// Which installer the command is built for: the ENVIRONMENT's own platform first, since a distro on a Windows PC takes
// the sh installer while its card says windows. The card's pinned platform answers for a row that never described
// itself.
const connectPlatform = (row: DeviceRow): string => String(row.device.platform ?? scopesOf(row)?.[`platform`] ?? `linux`);

const conflictTurn = (row: DeviceRow, group: DeviceSandboxGroup): ConflictAsk =>
    conflictAsk({
        machine: row.device.label,
        // Guarded by `fixable`, which already requires this device to have a host id.
        hostId: row.device.hostId ?? ``,
        localDir: group.folder?.localDir,
        conflicts: group.folder?.conflicts ?? 0,
        conflictedPaths: group.folder?.conflictedPaths ?? [],
    });

// The environment whose agent holds a group's folder: the door its file-sync buttons go through.
const ownerOf = (group: DeviceSandboxGroup): DeviceRow | undefined => folderOwner(machine, group);

// The one sandbox this page should arrive with unfolded; <DeviceDetail> unfolds anything needing attention
// on its own.
const openIds = computed(() => {
    const mine = selfGroup(machine, ownSlug);
    return mine === undefined ? [] : [mine.sandboxId];
});

const applyReshape = (ask: ResourcesAsk): void => ops.applyReshape(ask);
</script>

<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3">
            <!-- The way back out, above the name rather than beside it, so it is not read as part of the title. -->
            <RouterLink :to="boardRoute()" :class="ui.linkButton(`inline-flex w-fit items-center gap-1.5 text-2xs`)">
                <Icon name="chevron-right" class="rotate-180 text-2xs" aria-hidden="true" />
                All devices
            </RouterLink>

            <!-- The masthead tier, outside any group: this row outranks every list under it. -->
            <Row :flush="true" :heading="2" density="comfortable">
                <template #lead="{ mark }">
                    <span
                        class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                        :style="{ width: `${mark}px`, height: `${mark}px` }"
                    >
                        <Icon name="desktop" class="text-sm" />
                    </span>
                </template>
                <template #title>
                    <span class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span class="min-w-0 truncate">{{ machine.label }}</span>
                        <span v-if="masthead" class="shrink-0 truncate text-sm font-normal text-muted" :title="lone ? osTitle(lone.device) : undefined">
                            {{ masthead }}
                        </span>
                    </span>
                </template>
                <template v-if="hardware !== ``" #description>{{ hardware }}</template>
                <!-- A lone device's state rides its name; a many-sided machine's rides each environment's row. -->
                <template v-if="lone" #meta>
                    <!-- Noise on a live machine, the most useful fact on one that isn't. -->
                    <span v-if="lastSeenNote(lone.device)" class="shrink-0">{{ lastSeenNote(lone.device) }}</span>
                    <StatusBadge :variant="deviceTone(lone.device, readAt)" size="xs" :dot="true" :label="deviceState(lone.device, readAt)" class="shrink-0" />
                </template>
            </Row>

            <!-- What this device is doing for the sandbox: the one thing anybody opened the machine to read. -->
            <p v-if="lone && syncNote(lone.device, readAt)" class="min-w-0 text-xs" :class="syncStopped(lone.device, readAt) ? `text-warning` : `text-muted`">
                {{ syncNote(lone.device, readAt) }}
            </p>

            <!-- Everything the machine wants, in one place and one visual language, each sentence beside its own remedy. -->
            <template v-if="lone">
                <DeviceConcern
                    v-for="concern in concernsOf(lone)"
                    :key="concern.key"
                    :concern="concern"
                    :route="concern.fix?.kind === `card` ? cardRoute(concern.fix) : undefined"
                    @connect="reconnecting = lone.device.key"
                />
            </template>
        </div>

        <!-- The kit's agent group, the same block the desktop app's manager window draws for the device it runs on. -->
        <DeviceAgentGroup
            v-if="lone && agentOf(lone)"
            :panel="agentOf(lone)!"
            :subject="lone.device.label"
            :busy="ops.working.value"
            :running="ops.agentOp(lone)"
            :activity="agentActivity(lone)"
            @run="(op) => void ops.runAgent(lone!, op)"
        >
            <template #activity>
                <p v-if="ops.agentWaiting(lone)" class="text-xs text-muted">{{ ops.agentWaiting(lone) }}</p>
                <DeviceRunLog
                    v-if="ops.agentBusy(lone) || ops.agentLines(lone).length > 0"
                    :lines="ops.agentLines(lone)"
                    :running="ops.agentBusy(lone)"
                    empty="Starting on that device…"
                    note="Runs on that device, and keeps going if you leave this page or the connection drops."
                />
                <DeviceOpFailure
                    v-if="ops.agentFailure(lone)"
                    :of="ops.agentFailure(lone)!.notice"
                    :command="ops.agentFailure(lone)!.command"
                    :machine="lone.device.label"
                />
                <p v-else-if="ops.agentOutcome(lone)" class="text-xs text-muted">{{ ops.agentOutcome(lone) }}</p>
            </template>
        </DeviceAgentGroup>

        <!--
            A many-sided machine: one row per environment, each its own door with its own agent, permissions and
            concerns, since Windows and a distro on it are separate installs that happen to share the hardware.
        -->
        <RowGroup v-if="many" label="Environments on this device" :count="environments.length">
            <!-- One press for the computer, because one card is one computer: each side holds its own agent binary and
                 is updated in turn, its own log under its own row. Offered only where there is more than one side to
                 bring level; a single reachable environment has its row's own button and needs no wider word. -->
            <template v-if="updatable.length > 1" #actions>
                <Button
                    size="small"
                    severity="secondary"
                    label="Update all agents"
                    :loading="ops.agentEveryOp.value === `upgrade`"
                    :disabled="ops.working.value"
                    v-tooltip.top="`Fetches the newest agent onto every environment of this computer in turn — Windows and each distro run their own install, and this is what brings them to the same version. Safe on a side that is already current.`"
                    @click="void ops.runAgentEvery(updatable, `upgrade`)"
                />
            </template>

            <template v-for="environment in environments" :key="environment.device.key">
                <Row icon="desktop" :title="environmentTitle(environment)">
                    <template #description>
                        <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs">
                            <template v-for="(fact, index) in environmentFacts(environment)" :key="fact">
                                <span v-if="index > 0" class="text-subtle" aria-hidden="true">·</span>
                                <span :class="index === 0 && environment.device.hostId !== undefined ? `font-mono` : ``">{{ fact }}</span>
                            </template>
                        </span>
                    </template>
                    <template #meta>
                        <span v-if="lastSeenNote(environment.device)" class="shrink-0">{{ lastSeenNote(environment.device) }}</span>
                        <span v-if="agentOf(environment)?.version" class="font-mono">agent {{ agentOf(environment)?.version }}</span>
                        <StatusBadge
                            :variant="deviceTone(environment.device, readAt)"
                            size="xs"
                            :dot="true"
                            :label="deviceState(environment.device, readAt)"
                            class="shrink-0"
                        />
                    </template>
                    <!-- The agent's two verbs, per environment: each runs its own process. -->
                    <template v-if="(agentOf(environment)?.actions.length ?? 0) > 0" #control>
                        <Button
                            v-for="action in agentOf(environment)?.actions"
                            :key="action.op"
                            size="small"
                            severity="secondary"
                            :label="action.label"
                            :loading="ops.agentOp(environment) === action.op"
                            :disabled="ops.working.value"
                            v-tooltip.top="action.hint"
                            @click="void ops.runAgent(environment, action.op)"
                        />
                    </template>
                </Row>

                <!-- What this environment is doing for the sandbox, what it wants, and what its agent wants. -->
                <RowNote variant="block">
                    <div class="flex flex-col gap-2">
                        <p v-if="syncNote(environment.device, readAt)" class="min-w-0 text-xs" :class="syncStopped(environment.device, readAt) ? `text-warning` : `text-muted`">
                            {{ syncNote(environment.device, readAt) }}
                        </p>
                        <DeviceConcern
                            v-for="concern in concernsOf(environment)"
                            :key="concern.key"
                            :concern="concern"
                            :route="concern.fix?.kind === `card` ? cardRoute(concern.fix) : undefined"
                            @connect="reconnecting = environment.device.key"
                        />
                        <DeviceAgentNotes :notes="agentLinesOf(environment)" />
                        <template v-if="agentActivity(environment)">
                            <p v-if="ops.agentWaiting(environment)" class="text-xs text-muted">{{ ops.agentWaiting(environment) }}</p>
                            <DeviceRunLog
                                v-if="ops.agentBusy(environment) || ops.agentLines(environment).length > 0"
                                :lines="ops.agentLines(environment)"
                                :running="ops.agentBusy(environment)"
                                empty="Starting on that device…"
                                note="Runs on that device, and keeps going if you leave this page or the connection drops."
                            />
                            <DeviceOpFailure
                                v-if="ops.agentFailure(environment)"
                                :of="ops.agentFailure(environment)!.notice"
                                :command="ops.agentFailure(environment)!.command"
                                :machine="environment.device.label"
                            />
                            <p v-else-if="ops.agentOutcome(environment)" class="text-xs text-muted">{{ ops.agentOutcome(environment) }}</p>
                        </template>
                    </div>
                </RowNote>
            </template>

            <!-- The Windows side's distros, each with the door this sandbox holds into it or the way to open one. -->
            <RowNote v-if="distros.length > 0" variant="block">
                <div class="flex flex-col gap-1">
                    <p class="text-xs font-medium text-content">WSL distros on this PC</p>
                    <p v-for="distro in distros" :key="distro.name" class="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted">
                        <span class="font-mono text-content">{{ distro.name }}</span>
                        <span v-if="distro.connectedAs">connected as <span class="font-mono">{{ distro.connectedAs }}</span></span>
                        <template v-else>
                            <span>not connected</span>
                            <RouterLink :to="distro.connect" class="text-link hover:underline">Connect it</RouterLink>
                        </template>
                    </p>
                </div>
            </RowNote>
        </RowGroup>

        <!-- One row per sandbox, the page's only disclosure: a row is a summary and its folder, ports, image and share are the evidence. -->
        <!-- Either answer draws rows: a card granting sandbox management alone lists containers and describes no folders. -->
        <RowGroup v-if="described" label="Sandboxes on this device" :count="machine.groups.length">
            <!-- On a many-sided machine the door's block is about this list, so it is said here rather than under a row. -->
            <RowNote v-if="listBlock" variant="block">
                <DeviceConcern
                    :concern="listBlock"
                    :route="listBlock.fix?.kind === `card` ? cardRoute(listBlock.fix) : undefined"
                    @connect="reconnecting = manager === undefined ? undefined : manager.device.key"
                />
            </RowNote>

            <!-- The same two commands the pairing rows carry, run bare (every sandbox this environment pairs). -->
            <template v-for="environment in environments" :key="environment.device.key">
                <RowNote v-if="deviceSwitches(environment).length > 0" variant="block">
                    <div class="flex flex-col gap-2">
                        <p v-if="many" class="text-2xs text-subtle">{{ environmentTitle(environment) }}</p>
                        <div v-for="half in deviceSwitches(environment)" :key="half.label" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span class="text-xs font-medium text-content">{{ half.label }}</span>
                                <span
                                    class="inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium"
                                    :class="half.state === `off` ? `bg-content/5 text-subtle` : `bg-success/10 text-success`"
                                >
                                    {{ half.note ?? half.word }}
                                </span>
                                <!-- What "all" means: every label here says "all" without saying all of what. -->
                                <span class="text-2xs text-subtle">{{ half.scope }}</span>
                            </div>
                            <div class="flex flex-wrap items-center gap-1.5">
                                <Button
                                    v-for="action in half.actions"
                                    :key="action.command"
                                    size="small"
                                    severity="secondary"
                                    :label="action.label"
                                    :loading="ops.syncRunning(ops.switchKey(environment), action.command)"
                                    :disabled="ops.working.value"
                                    v-tooltip.top="action.hint"
                                    @click="void ops.runSync(environment, ops.switchKey(environment), undefined, action.command)"
                                />
                            </div>
                        </div>
                        <!-- The machine's own answer to a machine-wide click, shown where the click was. -->
                        <DeviceOpFailure
                            v-if="ops.failure.value?.key === ops.switchKey(environment)"
                            :of="ops.failure.value.notice"
                            :command="ops.failure.value.command"
                            :machine="environment.device.label"
                        />
                        <p v-else-if="ops.outcome.value?.key === ops.switchKey(environment)" class="text-xs text-muted">{{ ops.outcome.value.message }}</p>
                    </div>
                </RowNote>
            </template>

            <RowNote variant="block">
                <!-- No `agent` prop, deliberately: that state is the strip above, not a second liveness statement riding this list. -->
                <DeviceDetail :pairings="lists.pairings" :ports="lists.ports" :sandboxes="lists.sandboxes" :open="openIds">
                    <!-- The one row on this page that can close the page, said beside the name rather than only in the confirmation. -->
                    <template #badges="{ group }">
                        <StatusBadge v-if="ops.selfGroup(group)" variant="info" size="xs" label="the one you're using" />
                    </template>
                    <!-- The verbs are the kit's, so this page and the desktop app's manager window offer the same row. -->
                    <template #actions="{ group }">
                        <SandboxVerbs
                            v-if="manager && manageable(manager.device, group)"
                            :running="group.sandbox?.running === true"
                            :busy="ops.runningVerb(group)"
                            :disabled="ops.working.value"
                            :logs-open="ops.logShown(group)"
                            @act="(verb) => ops.act(group, verb)"
                        />
                    </template>
                    <!-- Controls for this pairing's files, under the folder rather than up with the container verbs: Pause stops no container, only the file movement. -->
                    <template #folder="{ group }">
                        <div class="mt-1 flex flex-wrap items-center gap-2">
                            <!-- Which side of a many-sided machine holds the folder: the path alone says it, but not in words. -->
                            <span v-if="many && ownerOf(group)" class="text-2xs text-subtle">on {{ environmentTitle(ownerOf(group)!) }}</span>
                            <!-- Before the turn, because it is the cheaper of the two and usually the only one needed:
                                 clearing build output that blocks a deletion needs no judgement, so it costs a command
                                 rather than an agent. -->
                            <Button
                                v-if="ownerOf(group) && clearable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="secondary"
                                label="Clear build output"
                                :loading="ops.syncRunning(ops.rowKey(group), `sync-clean`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="`Delete the build output this device left in directories the sandbox deleted, so those deletions can land. It removes nothing that syncs, and a build puts it back.`"
                                @click="void ops.runSync(ownerOf(group)!, ops.rowKey(group), group.sandboxId, `sync-clean`)"
                            >
                                <template #icon><Icon name="eraser" /></template>
                            </Button>
                            <!-- Only for conflicts with two real copies; starts a turn rather than a command. -->
                            <Button
                                v-if="ownerOf(group) && fixable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="secondary"
                                label="Fix with agent"
                                :disabled="ops.working.value"
                                v-tooltip.top="conflictTurn(ownerOf(group)!, group).hint"
                                @click="startAgent(conflictTurn(ownerOf(group)!, group).prompt)"
                            >
                                <template #icon><Icon name="sparkles" /></template>
                            </Button>
                            <Button
                                v-if="ownerOf(group) && pausable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="secondary"
                                :label="group.folder?.paused === true ? `Resume syncing` : `Pause syncing`"
                                :loading="ops.syncRunning(ops.rowKey(group), `sync-pause`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="
                                    group.folder?.paused === true
                                        ? `Start moving files between this device and the sandbox again`
                                        : `Stop moving files either way. The sandbox keeps running and its ports keep being mirrored.`
                                "
                                @click="
                                    void ops.runSync(
                                        ownerOf(group)!,
                                        ops.rowKey(group),
                                        group.sandboxId,
                                        group.folder?.paused === true ? `sync-resume` : `sync-pause`,
                                    )
                                "
                            />
                            <!-- The one control here nothing undoes in a click. -->
                            <Button
                                v-if="ownerOf(group) && commandable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="danger"
                                :text="true"
                                label="Unpair"
                                :loading="ops.syncRunning(ops.rowKey(group), `sync-unpair`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="`Stop this device syncing this sandbox. Its local folder is left exactly as it is.`"
                                @click="ops.confirmingUnpair.value = { environment: ownerOf(group)!, group }"
                            />
                        </div>
                    </template>
                    <!-- Nothing synced here yet: the folder field and the two ways to start, for this sandbox alone —
                         a pairing belongs to one sandbox and one machine, and only this one's daemon can mint it. -->
                    <template #sync="{ group }">
                        <SandboxSyncToggles v-if="ops.selfGroup(group)" :machine="machine" :group="group" :ops="ops" />
                    </template>
                    <!-- The switch that clears the user's own localhost, under the ports it's about rather than with the container verbs. -->
                    <template #ports="{ group }">
                        <div class="mt-1 flex flex-wrap items-center gap-2">
                            <Button
                                v-if="ownerOf(group) && commandable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="secondary"
                                :label="mirroringOff(group.folder) ? `Start mirroring` : `Stop mirroring`"
                                :loading="ops.syncRunning(ops.rowKey(group), `mirror-off`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="
                                    mirroringOff(group.folder)
                                        ? `Put this sandbox's ports back on this device's localhost`
                                        : `Take this sandbox's ports off this device's localhost. Files keep syncing.`
                                "
                                @click="
                                    void ops.runSync(
                                        ownerOf(group)!,
                                        ops.rowKey(group),
                                        group.sandboxId,
                                        mirroringOff(group.folder) ? `mirror-on` : `mirror-off`,
                                    )
                                "
                            />
                        </div>
                    </template>
                    <!-- The machine's own output, visible while a row works and afterward for as long as its log is being read. -->
                    <template #footer="{ group }">
                        <DeviceRunLog
                            v-if="ops.verbRunning(group) || ops.logShown(group)"
                            :lines="ops.lines(group)"
                            :running="ops.verbRunning(group)"
                            empty="Starting on that device…"
                            note="Running on that device. It keeps going even if you leave this page."
                        />
                        <DeviceOpFailure
                            v-if="ops.failure.value?.key === ops.rowKey(group)"
                            :of="ops.failure.value.notice"
                            :command="ops.failure.value.command"
                            :machine="machine.label"
                        />
                        <p v-else-if="ops.outcome.value?.key === ops.rowKey(group)" class="text-xs text-muted">{{ ops.outcome.value.message }}</p>
                    </template>
                </DeviceDetail>
            </RowNote>
        </RowGroup>

        <!-- What this sandbox keeps here, as opposed to what the person does: runners it can hand a conversation to, per door. -->
        <template v-for="environment in environments" :key="`runners:${environment.device.key}`">
            <DeviceRunners v-if="!many || environment.device.hostId !== undefined" :device="environment.device" />
        </template>

        <!-- Cutting an enrollment off entirely, in a group of its own at the bottom: it ends everything above it at once. -->
        <template v-for="environment in environments" :key="`revoke:${environment.device.key}`">
            <RowGroup v-if="environment.device.sync && isOwner" label="Danger zone">
                <Row icon="times" tone="danger" :title="many ? `Revoke ${environmentTitle(environment)}'s access` : `Revoke this device's access`">
                    <template #description>
                        Revoking stops this device reaching the sandbox at all. Nothing on it is deleted, and its agent stays installed.
                    </template>
                    <template #control>
                        <Button
                            size="small"
                            severity="danger"
                            label="Revoke access"
                            :disabled="ops.working.value"
                            @click="ops.confirmingRevoke.value = environment"
                        >
                            <template #icon><Icon name="times" /></template>
                        </Button>
                    </template>
                </Row>
                <RowNote v-if="ops.failure.value?.key === ops.accessKey(environment)" variant="block">
                    <DeviceOpFailure :of="ops.failure.value.notice" :command="ops.failure.value.command" :machine="environment.device.label" />
                </RowNote>
                <RowNote v-else-if="ops.outcome.value?.key === ops.accessKey(environment)">{{ ops.outcome.value.message }}</RowNote>
            </RowGroup>
        </template>

        <!-- Each environment's own pairing dialog, the one its capability card opens, mounted where its silence is read: a fresh single-use command to run out there. -->
        <template v-for="environment in environments" :key="`connect:${environment.device.key}`">
            <HostConnectDialog
                v-if="environment.device.hostId !== undefined"
                :id="environment.device.hostId"
                :visible="reconnecting === environment.device.key"
                :platform="connectPlatform(environment)"
                :permissions="machineGrants(capabilityOf(environment))"
                @update:visible="(open) => (reconnecting = open ? environment.device.key : undefined)"
                @connected="refetch()"
            />
        </template>

        <!-- Red only for removal: an image swap keeps the sandbox's files, so it isn't destructive. -->
        <ConfirmDialog
            :open="ops.confirmingAct.value !== undefined"
            :header="ops.actPrompt.value?.header ?? ``"
            :confirm-label="ops.actPrompt.value?.label ?? `Continue`"
            :destructive="ops.actPrompt.value?.destructive === true"
            @cancel="ops.confirmingAct.value = undefined"
            @confirm="ops.confirmAct()"
        >
            <p v-if="ops.actPrompt.value?.body !== undefined">{{ ops.actPrompt.value.body }}</p>
            <p v-if="ops.actPrompt.value?.severing === true" class="mt-3 text-xs text-warning">
                This is the sandbox you are using right now — this page will lose it.
            </p>
        </ConfirmDialog>

        <!-- The device form shows caps, rail size, and serving state. -->
        <SandboxResourcesDialog
            :open="ops.reshaping.value !== undefined"
            :name="ops.reshaping.value?.group.title ?? ``"
            :current="ops.reshaping.value?.group.sandbox?.resources"
            :engine="manager?.device.facts?.engine"
            :self-warning="ops.reshaping.value !== undefined && ops.selfGroup(ops.reshaping.value.group)"
            @cancel="ops.reshaping.value = undefined"
            @apply="applyReshape"
        />

        <!-- Names what survives as carefully as what ends: the local folder is untouched. -->
        <ConfirmDialog
            :open="ops.confirmingUnpair.value !== undefined"
            :header="`Unpair ${ops.confirmingUnpair.value?.group.title ?? `this sandbox`}?`"
            confirm-label="Unpair"
            :destructive="true"
            @cancel="ops.confirmingUnpair.value = undefined"
            @confirm="ops.confirmUnpair()"
        >
            <p>
                <span class="font-mono text-content">{{ ops.confirmingUnpair.value?.environment.device.label ?? machine.label }}</span> stops syncing this
                sandbox's files and mirroring its ports. Everything already in its local folder stays exactly as it is.
            </p>
            <p v-if="ops.confirmingUnpair.value?.group.folder?.localDir" class="mt-2 break-all font-mono text-xs text-content">
                {{ ops.confirmingUnpair.value.group.folder.localDir }}
            </p>
            <p class="mt-2">Pairing it again means running a fresh command on that device.</p>
        </ConfirmDialog>

        <!-- Named for the machine, explicit that it's this one alone. -->
        <ConfirmDialog
            :open="ops.confirmingRevoke.value !== undefined"
            :header="`Revoke ${ops.confirmingRevoke.value?.device.label ?? machine.label}'s access?`"
            confirm-label="Revoke access"
            confirm-icon="times"
            :destructive="true"
            :loading="ops.revoking.value"
            @cancel="ops.confirmingRevoke.value = undefined"
            @confirm="void ops.runRevoke()"
        >
            <p>
                This device alone loses access — every other paired device keeps syncing. Its file sync stops and its mirrored ports drop off its
                localhost within a minute.
            </p>
            <p class="mt-2">
                Nothing on that device is deleted and its agent stays installed, but letting it back in means running a fresh pairing command there.
            </p>
        </ConfirmDialog>
    </div>
</template>
