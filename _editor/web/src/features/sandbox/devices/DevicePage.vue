<script setup lang="ts">
import { hostCardOf } from "@intentic/sandbox-contract";
import {
    Button,
    ConfirmDialog,
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
import { RouterLink } from "vue-router";
import DeviceConcern from "./health/DeviceConcern.vue";
import DeviceEnvironment from "./DeviceEnvironment.vue";
import DeviceOpFailure from "./runners/DeviceOpFailure.vue";
import DeviceRunners from "./runners/DeviceRunners.vue";
import { boardRoute, cardRoute } from "./deviceLinks";
import { deviceAgentPanel } from "./deviceAgent";
import { blockAttention, deviceAttention } from "./health/deviceAttention";
import {
    commandable,
    type DeviceRow,
    deviceSwitches,
    clearable,
    fixable,
    folderOwner,
    machineHardware,
    type MachineRow,
    machineLists,
    machineState,
    manageable,
    managerOf,
    manySided,
    pausable,
    selfGroup,
} from "./deviceRows";
import { useDeviceOps } from "./runners/deviceOps";
import { environmentTitle, wslDistroRows } from "./machineEnvironments";
import { type ConflictAsk, conflictAsk } from "./sync/conflictAsk";
import SandboxSyncToggles from "./sync/SandboxSyncToggles.vue";
import { type DeviceScopes, manageBlock } from "./deviceFacts";
import { startAgent } from "../../agents/fleet/agentActions";
import HostConnectDialog from "../../capabilities/connect/HostConnectDialog.vue";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { isDefaultName } from "../../capabilities/model/cards";
import { machineGrants } from "../../capabilities/model/connections";
import { useRole } from "../secrets/useRole";
import { useT } from "@intentic/ui/i18n";

// One machine, as a page rather than an accordion body: who it is, what it wants from you, what this
// sandbox has on it, and — last, and set apart — how to cut it off. Every button here acts on this one
// machine, so one op at a time is the whole page's rule (see deviceOps.ts). A PC connected through several
// environments (Windows and the distros on it) is still one page: its environments are rows of their own, each
// with its agent and its concerns, and its sandboxes are listed once, since one engine serves every door.
//
// THE PAGE STATES A FACT ONCE. A machine whose Windows side was asleep used to say so four times — a badge, a
// last-seen, a paragraph and an agent note — and name its own environments three times over. So: the badge owns
// the state word, one line owns the errand, and a section is drawn for the MACHINE rather than once per door.
// <DeviceEnvironment> is that rule made structural: a lone machine's masthead and a many-sided one's rows are the
// same component, which is why they can no longer drift.

const t = useT();

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

const concernsOf = (row: DeviceRow) => deviceAttention(row, { block: many.value ? undefined : block.value, readAt, canPair: isOwner.value });

// The agent as its own object rather than a version printed under the name: what it serves, what it wants,
// and the two verbs that change either. Undefined only on a machine with no version and no command door.
const agentOf = (row: DeviceRow) => deviceAgentPanel(row, latest, readAt);

// The environments an agent op can actually be sent to — the same rule the row buttons are drawn from, so the
// machine-wide control offers exactly what those buttons would.
const updatable = computed(() => environments.value.filter((environment) => (agentOf(environment)?.actions.length ?? 0) > 0));

// One verdict for the whole PC, so the masthead of a many-sided machine carries a state instead of listing the
// environment names that are the section directly beneath it.
const state = computed(() => machineState(machine, readAt));
const hardware = computed(() => machineHardware(machine));

// The Windows side's distros this sandbox holds NO door into: the connected ones are rows of their own, and
// listing them again was this page's third telling of its own environments.
const distros = computed(() => wslDistroRows(machine));

// Enrollments this reader may cut off. One list, so the page has one Danger zone however many doors the PC has.
const revocable = computed(() => (isOwner.value ? environments.value.filter((environment) => environment.device.sync !== undefined) : []));

// The machine's three lists as the detail kit takes them, merged across environments.
const lists = computed(() => machineLists(environments.value));
const described = computed(() =>
    environments.value.some((environment) => environment.device.report !== undefined || environment.device.sandboxes !== undefined),
);

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
                {{ t(`sandbox.devicePage.allDevices`) }}
            </RouterLink>

            <!-- A LONE machine's masthead IS its environment row: the name, the agent it runs and that agent's two
                 verbs, rather than a title here and a whole Agent section restating it below. -->
            <DeviceEnvironment
                v-if="lone"
                :environment="lone"
                :panel="agentOf(lone)"
                :concerns="concernsOf(lone)"
                :read-at="readAt"
                :ops="ops"
                :masthead="true"
                :hardware="hardware"
                @connect="reconnecting = lone.device.key"
            />

            <!-- A many-sided machine's masthead carries one verdict for the PC; its sides are the section below. -->
            <Row v-else :flush="true" :heading="2">
                <template #lead="{ mark }">
                    <span
                        class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                        :style="{ width: `${mark}px`, height: `${mark}px` }"
                    >
                        <Icon name="desktop" class="text-sm" />
                    </span>
                </template>
                <template #title>{{ machine.label }}</template>
                <template v-if="hardware !== ``" #description>{{ hardware }}</template>
                <template #meta>
                    <StatusBadge :variant="state.variant" size="xs" :dot="true" :label="state.word" class="shrink-0" />
                </template>
            </Row>
        </div>

        <!--
            A many-sided machine: one row per environment, each its own door with its own agent, permissions and
            concerns, since Windows and a distro on it are separate installs that happen to share the hardware.
        -->
        <RowGroup v-if="many" :label="t(`sandbox.devicePage.environments`)">
            <!-- One press for the computer, because one card is one computer: each side holds its own agent binary and
                 is updated in turn, its own log under its own row. Offered only where there is more than one side to
                 bring level; a single reachable environment has its row's own button and needs no wider word. -->
            <template v-if="updatable.length > 1" #actions>
                <Button
                    size="small"
                    severity="secondary"
                    :label="t(`sandbox.devicePage.updateAgents`)"
                    :loading="ops.agentEveryOp.value === `upgrade`"
                    :disabled="ops.working.value"
                    v-tooltip.top="t(`sandbox.devicePage.fetchesNewestAgentOnto`)"
                    @click="void ops.runAgentEvery(updatable, `upgrade`)"
                />
            </template>

            <DeviceEnvironment
                v-for="environment in environments"
                :key="environment.device.key"
                :environment="environment"
                :panel="agentOf(environment)"
                :concerns="concernsOf(environment)"
                :read-at="readAt"
                :ops="ops"
                @connect="reconnecting = environment.device.key"
            />

            <!-- The rest of this PC, as rows in the same list: a distro that is here but holds no door yet. A
                 connected one is already a row above, and saying so twice is what made this a second list. -->
            <Row v-for="distro in distros" :key="distro.name" icon="desktop" :description="t(`sandbox.devicePage.notConnected`)">
                <template #title><span class="font-mono">{{ distro.name }}</span></template>
                <template #control>
                    <Button
                        :as="RouterLink"
                        :to="distro.connect"
                        size="small"
                        severity="secondary"
                        :text="true"
                        :label="t(`sandbox.devicePage.connect`)"
                    >
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                </template>
            </Row>
        </RowGroup>

        <!-- One row per sandbox, the page's only disclosure: a row is a summary and its folder, ports, image and share are the evidence. -->
        <!-- Either answer draws rows: a card granting sandbox management alone lists containers and describes no folders. -->
        <RowGroup v-if="described" :label="t(`sandbox.devicePage.sandboxes`)" :count="lists.sandboxes.length || undefined">
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
                        <div
                            v-for="half in deviceSwitches(environment)"
                            :key="half.label"
                            class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5"
                        >
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
                        <p v-else-if="ops.outcome.value?.key === ops.switchKey(environment)" class="text-xs text-muted">
                            {{ ops.outcome.value.message }}
                        </p>
                    </div>
                </RowNote>
            </template>

            <RowNote variant="block">
                <!-- No `agent` prop, deliberately: that state is the strip above, not a second liveness statement riding this list. -->
                <DeviceDetail :pairings="lists.pairings" :ports="lists.ports" :sandboxes="lists.sandboxes" :open="openIds">
                    <!-- The one row on this page that can close the page, said beside the name rather than only in the confirmation. -->
                    <template #badges="{ group }">
                        <StatusBadge v-if="ops.selfGroup(group)" variant="info" size="xs" :label="t(`sandbox.devicePage.oneYoureUsing`)" />
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
                            <span v-if="many && ownerOf(group)" class="text-2xs text-subtle">{{
                                t(`sandbox.devicePage.on`, { group: environmentTitle(ownerOf(group)!) })
                            }}</span>
                            <!-- Before the turn, because it is the cheaper of the two and usually the only one needed:
                                 clearing build output that blocks a deletion needs no judgement, so it costs a command
                                 rather than an agent. -->
                            <Button
                                v-if="ownerOf(group) && clearable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="secondary"
                                :label="t(`sandbox.devicePage.clearBuildOutput`)"
                                :loading="ops.syncRunning(ops.rowKey(group), `sync-clean`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="t(`sandbox.devicePage.deleteBuildOutputDevice`)"
                                @click="void ops.runSync(ownerOf(group)!, ops.rowKey(group), group.sandboxId, `sync-clean`)"
                            >
                                <template #icon><Icon name="eraser" /></template>
                            </Button>
                            <!-- Only for conflicts with two real copies; starts a turn rather than a command. -->
                            <Button
                                v-if="ownerOf(group) && fixable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="secondary"
                                :label="t(`sandbox.devicePage.fixAgent`)"
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
                                :label="group.folder?.paused === true ? t(`sandbox.devicePage.resumeSyncing`) : t(`sandbox.devicePage.pauseSyncing`)"
                                :loading="ops.syncRunning(ops.rowKey(group), `sync-pause`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="
                                    group.folder?.paused === true
                                        ? t(`sandbox.devicePage.startMovingFilesBetween`)
                                        : t(`sandbox.devicePage.stopMovingFilesEither`)
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
                                :label="t(`sandbox.devicePage.unpair`)"
                                :loading="ops.syncRunning(ops.rowKey(group), `sync-unpair`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="t(`sandbox.devicePage.stopDeviceSyncingSandbox`)"
                                @click="ops.confirmingUnpair.value = { environment: ownerOf(group)!, group }"
                            />
                        </div>
                    </template>
                    <!-- Nothing synced here yet: the folder field and the two ways to start, for this sandbox alone —
                         a pairing belongs to one sandbox and one machine, and only this one's daemon can mint it. -->
                    <template #sync="{ group }">
                        <SandboxSyncToggles v-if="ops.selfGroup(group)" :machine="machine" :group="group" :ops="ops" />
                    </template>
                    <!-- ONE PORT'S OWN SWITCH, for the two outcomes localhost is never going to sort out by itself: a
                         number something else on this machine permanently holds, and one already set aside. Absent on a
                         mirrored port, where the row is working and a button per port would say nothing six times. -->
                    <template #port="{ group, port }">
                        <Button
                            v-if="port.state !== `mirrored` && ownerOf(group) && commandable(ownerOf(group)!.device, group)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            class="-my-1"
                            :label="port.state === `ignored` ? t(`sandbox.devicePage.mirrorPortAgain`) : t(`sandbox.devicePage.dontMirrorPort`)"
                            :loading="ops.syncRunning(ops.rowKey(group), `mirror-ignore`, port.port)"
                            :disabled="ops.working.value"
                            v-tooltip.top="
                                port.state === `ignored`
                                    ? t(`sandbox.devicePage.putPortBackOnLocalhost`)
                                    : t(`sandbox.devicePage.leavePortOffLocalhost`)
                            "
                            @click="
                                void ops.runSync(
                                    ownerOf(group)!,
                                    ops.rowKey(group),
                                    group.sandboxId,
                                    port.state === `ignored` ? `mirror-unignore` : `mirror-ignore`,
                                    { port: port.port },
                                )
                            "
                        />
                    </template>
                    <!-- The switch that clears the user's own localhost, under the ports it's about rather than with the container verbs. -->
                    <template #ports="{ group }">
                        <div class="mt-1 flex flex-wrap items-center gap-2">
                            <Button
                                v-if="ownerOf(group) && commandable(ownerOf(group)!.device, group)"
                                size="small"
                                severity="secondary"
                                :label="mirroringOff(group.folder) ? t(`sandbox.devicePage.startMirroring`) : t(`sandbox.devicePage.stopMirroring`)"
                                :loading="ops.syncRunning(ops.rowKey(group), `mirror-off`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="
                                    mirroringOff(group.folder)
                                        ? t(`sandbox.devicePage.putSandboxsPortsBack`)
                                        : t(`sandbox.devicePage.takeSandboxsPortsOff`)
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
                            :empty="t(`sandbox.devicePage.startingOnDevice`)"
                            :note="t(`sandbox.devicePage.runningOnDeviceKeeps`)"
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

        <!-- What this sandbox keeps here, as opposed to what the person does: runners it can hand a conversation to.
             One group for the PC, not one per door — one Docker engine serves every door, and drawing it per
             environment printed the same heading twice with two empty states under it. -->
        <DeviceRunners :machine="machine" />

        <!-- Cutting an enrollment off entirely, in one group at the bottom: it ends everything above it at once.
             One row per enrollment, since each side of a PC pairs on its own and is revoked on its own. -->
        <RowGroup v-if="revocable.length > 0" :label="t(`sandbox.devicePage.dangerZone`)">
            <template v-for="environment in revocable" :key="`revoke:${environment.device.key}`">
                <Row
                    icon="times"
                    tone="danger"
                    :title="
                        many
                            ? t(`sandbox.devicePage.revokeSAccess`, { environment: environmentTitle(environment) })
                            : t(`sandbox.devicePage.revokeDevicesAccess`)
                    "
                >
                    <template #description>
                        {{ t(`sandbox.devicePage.revokingStopsDeviceReaching`) }}
                    </template>
                    <template #control>
                        <Button
                            size="small"
                            severity="danger"
                            :label="t(`sandbox.devicePage.revokeAccess`)"
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
            </template>
        </RowGroup>

        <!-- Each environment's own pairing dialog, the one its capability card opens, mounted where its silence is read: a fresh single-use command to run out there. -->
        <template v-for="environment in environments" :key="`connect:${environment.device.key}`">
            <HostConnectDialog
                v-if="environment.device.hostId !== undefined"
                :id="environment.device.hostId"
                :visible="reconnecting === environment.device.key"
                :platform="connectPlatform(environment)"
                :permissions="machineGrants(capabilityOf(environment))"
                :unnamed="isDefaultName(connectPlatform(environment), environment.device.hostId)"
                @update:visible="(open) => (reconnecting = open ? environment.device.key : undefined)"
                @connected="refetch()"
                @renamed="refetch()"
            />
        </template>

        <!-- Red only for removal: an image swap keeps the sandbox's files, so it isn't destructive. -->
        <ConfirmDialog
            :open="ops.confirmingAct.value !== undefined"
            :header="ops.actPrompt.value?.header ?? ``"
            :confirm-label="ops.actPrompt.value?.label ?? t(`ui.action.continue`)"
            :destructive="ops.actPrompt.value?.destructive === true"
            @cancel="ops.confirmingAct.value = undefined"
            @confirm="ops.confirmAct()"
        >
            <p v-if="ops.actPrompt.value?.body !== undefined">{{ ops.actPrompt.value.body }}</p>
            <p v-if="ops.actPrompt.value?.severing === true" class="mt-3 text-xs text-warning">
                {{ t(`sandbox.devicePage.sandboxUsingRightNow`) }}
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
            :header="
                t(`sandbox.devicePage.unpairHeader`, { sandbox: ops.confirmingUnpair.value?.group.title ?? t(`sandbox.devicePage.thisSandbox`) })
            "
            :confirm-label="t(`sandbox.devicePage.unpair`)"
            :destructive="true"
            @cancel="ops.confirmingUnpair.value = undefined"
            @confirm="ops.confirmUnpair()"
        >
            <p>
                <span class="font-mono text-content">{{ ops.confirmingUnpair.value?.environment.device.label ?? machine.label }}</span>
                {{ t(`sandbox.devicePage.stopsSyncingSandboxsFiles`) }}
            </p>
            <p v-if="ops.confirmingUnpair.value?.group.folder?.localDir" class="mt-2 break-all font-mono text-xs text-content">
                {{ ops.confirmingUnpair.value.group.folder.localDir }}
            </p>
            <p class="mt-2">{{ t(`sandbox.devicePage.pairingAgainMeansRunning`) }}</p>
        </ConfirmDialog>

        <!-- Named for the machine, explicit that it's this one alone. -->
        <ConfirmDialog
            :open="ops.confirmingRevoke.value !== undefined"
            :header="t(`sandbox.devicePage.revokeSAccess2`, { label: ops.confirmingRevoke.value?.device.label ?? machine.label })"
            :confirm-label="t(`sandbox.devicePage.revokeAccess`)"
            confirm-icon="times"
            :destructive="true"
            :loading="ops.revoking.value"
            @cancel="ops.confirmingRevoke.value = undefined"
            @confirm="void ops.runRevoke()"
        >
            <p>
                {{ t(`sandbox.devicePage.deviceAloneLosesAccess`) }}
            </p>
            <p class="mt-2">
                {{ t(`sandbox.devicePage.nothingOnDeviceDeleted`) }}
            </p>
        </ConfirmDialog>
    </div>
</template>
