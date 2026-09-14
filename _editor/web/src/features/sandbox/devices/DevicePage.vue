<script setup lang="ts">
import {
    Button,
    ConfirmDialog,
    DeviceDetail,
    DeviceRunLog,
    type DeviceSandboxGroup,
    Icon,
    mirroringOff,
    Notice,
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
import DeviceRunners from "./DeviceRunners.vue";
import { boardRoute } from "./deviceLinks";
import { deviceAgentPanel } from "./deviceAgent";
import { type DeviceCardFix, deviceAttention } from "./deviceAttention";
import { commandable, type DeviceRow, deviceState, deviceSwitches, deviceTone, fixable, manageable, pausable, selfGroup } from "./deviceRows";
import { useDeviceOps } from "./deviceOps";
import { type ConflictAsk, conflictAsk } from "./sync/conflictAsk";
import { type DeviceScopes, deviceDoors, deviceHardware, lastSeenNote, manageBlock, osLabel, osTitle, syncNote, syncStopped } from "./deviceFacts";
import { startAgent } from "../../agents/fleet/agentActions";
import HostConnectDialog from "../../capabilities/connect/HostConnectDialog.vue";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { machineGrants } from "../../capabilities/model/connections";
import { useRole } from "../secrets/useRole";

// One machine, as a page rather than an accordion body: who it is, what it wants from you, what this
// sandbox has on it, and — last, and set apart — how to cut it off. Every button here acts on this one
// machine, so one op at a time is the whole page's rule (see deviceOps.ts).

const { row, latest, ownSlug, readAt, refetch } = defineProps<{
    row: DeviceRow;
    /** The release this sandbox knows about; undefined on a dev build or a sandbox that never reached the registry. */
    latest: string | undefined;
    ownSlug: string | undefined;
    /** When this reading landed; the machine is judged as of then, not as of now (see deviceFacts.ts). */
    readAt: number;
    refetch: () => void;
}>();

const device = computed(() => row.device);
const ops = useDeviceOps(() => row, refetch);

// Why a row has no buttons, read from the capability rather than discovered by a click.
const { capabilities } = useCapabilities();
const capability = computed(() =>
    device.value.hostId === undefined ? undefined : capabilities.value.find((entry) => entry.id === device.value.hostId),
);
const scopes = computed<DeviceScopes | undefined>(() => capability.value?.config);
const block = computed(() => manageBlock(device.value, scopes.value));

// Owner-only, per machine, no fleet-wide equivalent: the only path that works for a laptop that is lost,
// wiped, or someone else's. Minting this machine a fresh pairing has the same floor (the daemon refuses a
// member's), so the same answer decides whether Reconnect is offered at all.
const { isOwner } = useRole();

const concerns = computed(() => deviceAttention(row, { block: block.value, readAt, canPair: isOwner.value }));

// The agent as its own object rather than a version printed under the name: what it serves, what it wants,
// and the two verbs that change either. Undefined only on a machine with no version and no command door.
const agent = computed(() => deviceAgentPanel(row, latest));

const cardRoute = (fix: DeviceCardFix): RouteLocationRaw => {
    const card = { name: `capabilities`, params: { card: fix.card } };
    return fix.connection === undefined ? card : { ...card, query: { edit: fix.connection } };
};

// The machine's own facts, in the quietest ink: read once per device, mostly to tell two identically-named
// ones apart. The enrollment's own line joins them, since it is a fact about the machine too.
const hardware = computed(() => [...deviceHardware(device.value), ...deviceDoors(device.value).map((door) => door.name)].join(` · `));

const switches = computed(() => deviceSwitches(row));

// Reconnecting is the one remedy that doesn't travel over the machine's own socket — there isn't one — so it is a
// dialog rather than an op: it mints a fresh single-use command here for the reader to run out there. Opened from
// the sentence that explains the silence, instead of sending anyone off to find the machine's capability card.
const reconnecting = ref(false);
// Which installer the command is built for: the card's own platform first, the row's fallback second, the same
// order manageBlock reads them in.
const connectPlatform = computed(() => String(scopes.value?.[`platform`] ?? device.value.platform ?? `linux`));
// What the machine will enforce once it is back, in its card's own words; the dialog states it under the command.
const grants = computed(() => machineGrants(capability.value));

const conflictTurn = (group: DeviceSandboxGroup): ConflictAsk =>
    conflictAsk({
        machine: device.value.label,
        // Guarded by `fixable`, which already requires this device to have a host id.
        hostId: device.value.hostId ?? ``,
        localDir: group.folder?.localDir,
        conflicts: group.folder?.conflicts ?? 0,
        conflictedPaths: group.folder?.conflictedPaths ?? [],
    });

// The one sandbox this page should arrive with unfolded; <DeviceDetail> unfolds anything needing attention
// on its own.
const openIds = computed(() => {
    const mine = selfGroup(row, ownSlug);
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
                        <span class="min-w-0 truncate">{{ device.label }}</span>
                        <span v-if="osLabel(device)" class="shrink-0 truncate text-sm font-normal text-muted" :title="osTitle(device)">
                            {{ osLabel(device) }}
                        </span>
                    </span>
                </template>
                <template v-if="hardware !== ``" #description>{{ hardware }}</template>
                <template #meta>
                    <!-- Noise on a live machine, the most useful fact on one that isn't. -->
                    <span v-if="lastSeenNote(device)" class="shrink-0">{{ lastSeenNote(device) }}</span>
                    <StatusBadge
                        :variant="deviceTone(device, readAt)"
                        size="xs"
                        :dot="true"
                        :label="deviceState(device, readAt)"
                        class="shrink-0"
                    />
                </template>
            </Row>

<!-- What this device is doing for the sandbox: the one thing anybody opened the machine to read. -->
            <p v-if="syncNote(device, readAt)" class="min-w-0 text-xs" :class="syncStopped(device, readAt) ? `text-warning` : `text-muted`">
                {{ syncNote(device, readAt) }}
            </p>

<!-- Everything the machine wants, in one place and one visual language, each sentence beside its own remedy. -->
            <Notice v-for="concern in concerns" :key="concern.key" :tone="concern.tone">
                <span class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span class="min-w-0">
                        {{ concern.text }}
                        <!-- Kept on one line: a command broken across a wrap can't be copied by eye. -->
                        <template v-if="concern.command">
                            Run <span class="font-mono whitespace-nowrap text-content">{{ concern.command }}</span> on that device.
                        </template>
                    </span>
                    <!-- A link wearing the button's clothes, since this fix has an address: hoverable and Ctrl/⌘-clickable. -->
                    <Button
                        v-if="concern.fix?.kind === `card`"
                        :as="RouterLink"
                        :to="cardRoute(concern.fix)"
                        size="small"
                        severity="secondary"
                        :text="true"
                        :label="concern.fix.label"
                    >
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <!-- Connect actions request a command for the machine without running one locally. -->
                    <Button
                        v-else-if="concern.fix?.kind === `connect`"
                        size="small"
                        severity="secondary"
                        :label="concern.fix.label"
                        v-tooltip.top="concern.fix.hint"
                        @click="reconnecting = true"
                    >
                        <template #icon><Icon name="desktop" /></template>
                    </Button>
                </span>
            </Notice>
        </div>

        <!--
            The agent, as an object with verbs rather than a version printed under the machine's name. Above the
            two lists because it is what makes their buttons work, and because updating it used to mean walking to
            the machine: the controls are standing ones, offered on a healthy agent too, since "behind" is a
            comparison this sandbox can only make when it knows what has been published.
        -->
        <RowGroup v-if="agent" label="Agent on this device">
            <Row icon="desktop" :title="agent.version === undefined ? `Agent` : `Agent ${agent.version}`">
                <template #description>
                    The one process this sandbox reaches {{ device.label }} through — its folders, its ports, and every button below.
                </template>
                <template #meta>
                    <span v-for="fact in agent.facts" :key="fact" class="font-mono">{{ fact }}</span>
                    <StatusBadge :variant="agent.state.variant" size="xs" :dot="true" :label="agent.state.word" />
                </template>
                <!-- Both ops run on that device over its own socket, so both spin the whole page's one-op-at-a-time lock. -->
                <template v-if="agent.actions.length > 0" #control>
                    <Button
                        v-for="action in agent.actions"
                        :key="action.op"
                        size="small"
                        severity="secondary"
                        :label="action.label"
                        :loading="ops.agentRunning(action.op)"
                        :disabled="ops.working.value"
                        v-tooltip.top="action.hint"
                        @click="void ops.runAgent(action.op)"
                    />
                </template>
            </Row>

            <!-- What this agent wants, or what has been published; the settled case still gets its one quiet line. -->
            <RowNote variant="block">
                <div class="flex flex-col gap-2">
                    <template v-for="note in agent.notes" :key="note.text">
                        <Notice v-if="note.tone" :tone="note.tone">{{ note.text }}</Notice>
                        <p v-else class="text-xs text-muted">{{ note.text }}</p>
                    </template>
                    <!-- Said where the buttons would have been, rather than leaving their absence to be guessed. -->
                    <p v-if="agent.blocked" class="text-xs text-muted">{{ agent.blocked }}</p>
                </div>
            </RowNote>

            <!-- Agent operations report status and output in one block. -->
            <RowNote
                v-if="
                    ops.agentWaiting.value ||
                    ops.agentBusy.value ||
                    ops.agentLines.value.length > 0 ||
                    ops.failure.value?.key === ops.agentKey.value ||
                    ops.outcome.value?.key === ops.agentKey.value
                "
                variant="block"
            >
                <div class="flex min-w-0 flex-col gap-2">
                    <p v-if="ops.agentWaiting.value" class="text-xs text-muted">{{ ops.agentWaiting.value }}</p>
                    <DeviceRunLog
                        v-if="ops.agentBusy.value || ops.agentLines.value.length > 0"
                        :lines="ops.agentLines.value"
                        :running="ops.agentBusy.value"
                        empty="Starting on that device…"
                        note="Running on that device. It keeps going even if you leave this page, and it survives the connection dropping."
                    />
                    <Notice v-if="ops.failure.value?.key === ops.agentKey.value" :of="ops.failure.value.notice" />
                    <p v-else-if="ops.outcome.value?.key === ops.agentKey.value" class="text-xs text-muted">{{ ops.outcome.value.message }}</p>
                </div>
            </RowNote>
        </RowGroup>

<!-- One row per sandbox, the page's only disclosure: a row is a summary and its folder, ports, image and share are the evidence. -->
<!-- Either answer draws rows: a card granting sandbox management alone lists containers and describes no folders. -->
        <RowGroup v-if="device.report || device.sandboxes" label="Sandboxes on this device" :count="row.groups.length">
<!-- The same two commands the pairing rows carry, run bare (every sandbox this machine pairs). -->
            <RowNote v-if="switches.length > 0" variant="block">
                <div class="flex flex-col gap-2">
                    <div v-for="half in switches" :key="half.label" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
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
                                :loading="ops.syncRunning(ops.machineKey.value, action.command)"
                                :disabled="ops.working.value"
                                v-tooltip.top="action.hint"
                                @click="void ops.runSync(ops.machineKey.value, undefined, action.command)"
                            />
                        </div>
                    </div>
                    <!-- The machine's own answer to a machine-wide click, shown where the click was. -->
                    <Notice v-if="ops.failure.value?.key === ops.machineKey.value" :of="ops.failure.value.notice" />
                    <p v-else-if="ops.outcome.value?.key === ops.machineKey.value" class="text-xs text-muted">{{ ops.outcome.value.message }}</p>
                </div>
            </RowNote>

            <RowNote variant="block">
<!-- No `agent` prop, deliberately: that state is the strip above, not a second liveness statement riding this list. -->
                <DeviceDetail
                    :pairings="device.report?.pairings ?? []"
                    :ports="device.report?.ports ?? []"
                    :sandboxes="device.sandboxes ?? []"
                    :open="openIds"
                >
                    <!-- The one row on this page that can close the page, said beside the name rather than only in the confirmation. -->
                    <template #badges="{ group }">
                        <StatusBadge v-if="ops.selfGroup(group)" variant="info" size="xs" label="the one you're using" />
                    </template>
                    <!-- The verbs are the kit's, so this page and the desktop app's manager window offer the same row. -->
                    <template #actions="{ group }">
                        <SandboxVerbs
                            v-if="manageable(device, group)"
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
<!-- First, since a row with conflicts is open because of them; starts a turn rather than a command. -->
                            <Button
                                v-if="fixable(device, group)"
                                size="small"
                                severity="secondary"
                                label="Fix with agent"
                                :disabled="ops.working.value"
                                v-tooltip.top="conflictTurn(group).hint"
                                @click="startAgent(conflictTurn(group).prompt)"
                            >
                                <template #icon><Icon name="sparkles" /></template>
                            </Button>
                            <Button
                                v-if="pausable(device, group)"
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
                                        ops.rowKey(group),
                                        group.sandboxId,
                                        group.folder?.paused === true ? `sync-resume` : `sync-pause`,
                                    )
                                "
                            />
<!-- The one control here nothing undoes in a click. -->
                            <Button
                                v-if="commandable(device, group)"
                                size="small"
                                severity="danger"
                                :text="true"
                                label="Unpair"
                                :loading="ops.syncRunning(ops.rowKey(group), `sync-unpair`)"
                                :disabled="ops.working.value"
                                v-tooltip.top="`Stop this device syncing this sandbox. Its local folder is left exactly as it is.`"
                                @click="ops.confirmingUnpair.value = { group }"
                            />
                        </div>
                    </template>
<!-- The switch that clears the user's own localhost, under the ports it's about rather than with the container verbs. -->
                    <template #ports="{ group }">
                        <div class="mt-1 flex flex-wrap items-center gap-2">
                            <Button
                                v-if="commandable(device, group)"
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
                                    void ops.runSync(ops.rowKey(group), group.sandboxId, mirroringOff(group.folder) ? `mirror-on` : `mirror-off`)
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
                        <Notice v-if="ops.failure.value?.key === ops.rowKey(group)" :of="ops.failure.value.notice" />
                        <p v-else-if="ops.outcome.value?.key === ops.rowKey(group)" class="text-xs text-muted">{{ ops.outcome.value.message }}</p>
                    </template>
                </DeviceDetail>
            </RowNote>
        </RowGroup>

<!-- What this sandbox keeps here, as opposed to what the person does: runners it can hand a conversation to. -->
        <DeviceRunners :device="device" />

<!-- Cutting this device off entirely, in a group of its own at the bottom: it ends everything above it at once. -->
        <RowGroup v-if="device.sync && isOwner" label="Danger zone">
            <Row icon="times" tone="danger" title="Revoke this device's access">
                <template #description>
                    Revoking stops this device reaching the sandbox at all. Nothing on it is deleted, and its agent stays installed.
                </template>
                <template #control>
                    <Button
                        size="small"
                        severity="danger"
                        label="Revoke access"
                        :disabled="ops.working.value"
                        @click="ops.confirmingRevoke.value = true"
                    >
                        <template #icon><Icon name="times" /></template>
                    </Button>
                </template>
            </Row>
            <RowNote v-if="ops.failure.value?.key === ops.accessKey.value" variant="block">
                <Notice :of="ops.failure.value.notice" />
            </RowNote>
            <RowNote v-else-if="ops.outcome.value?.key === ops.accessKey.value">{{ ops.outcome.value.message }}</RowNote>
        </RowGroup>

<!-- The machine's own pairing dialog, the one its capability card opens, mounted where its silence is read: a fresh single-use command to run out there. -->
        <HostConnectDialog
            v-if="device.hostId !== undefined"
            :id="device.hostId"
            v-model:visible="reconnecting"
            :platform="connectPlatform"
            :permissions="grants"
            @connected="refetch()"
        />

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
            :engine="device.facts?.engine"
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
                <span class="font-mono text-content">{{ device.label }}</span> stops syncing this sandbox's files and mirroring its ports. Everything
                already in its local folder stays exactly as it is.
            </p>
            <p v-if="ops.confirmingUnpair.value?.group.folder?.localDir" class="mt-2 break-all font-mono text-xs text-content">
                {{ ops.confirmingUnpair.value.group.folder.localDir }}
            </p>
            <p class="mt-2">Pairing it again means running a fresh command on that device.</p>
        </ConfirmDialog>

        <!-- Named for the machine, explicit that it's this one alone. -->
        <ConfirmDialog
            :open="ops.confirmingRevoke.value"
            :header="`Revoke ${device.label}'s access?`"
            confirm-label="Revoke access"
            confirm-icon="times"
            :destructive="true"
            :loading="ops.revoking.value"
            @cancel="ops.confirmingRevoke.value = false"
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
