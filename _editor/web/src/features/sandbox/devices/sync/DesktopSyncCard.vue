<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, ui, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { runDeviceCommand, useDevices } from "../useDevices";
import { useOperations } from "../../../../workbench/operations/operations";
import { useDesktopSync } from "./useDesktopSync";
import { beginDeviceWork, machineKeyOf } from "../runners/deviceWork";
import { desktopVersion, openDesktopLink } from "../../../../app/environments/desktop";
import RunCommand from "../../../../components/RunCommand.vue";
import { useT } from "@intentic/ui/i18n";

// Mints a device pairing: pick a folder, click Enable, run the one-liner on the target machine. Two modes:
// full sync (file sync + ports, single holder, maintainer and up) and mirror (ports only, any device). Body only:
// <AddDeviceDialog> frames it, so this draws no heading of its own.

const t = useT();

const {
    canOperate,
    available,
    statusError,
    folder,
    pairToken,
    pairMode,
    pairExpiresAt,
    minting,
    mintFailure,
    takeover,
    command,
    desktopLink,
    enable,
    forget,
} = useDesktopSync();

// Whether a device holds file sync, read off the already-fetched devices list (same query, no extra poll).
const { devices, refetch } = useDevices({ poll: false });
const holder = computed<Device | undefined>(() => devices.value.find((device) => device.sync?.mode === `sync`));

// Machines already connected as devices and answering right now: the install can be RUN on them from here, so
// there is nothing to paste. One already enrolled with this sandbox is not a candidate — its own row on the
// Devices board owns everything about that pairing.
const candidates = computed(() =>
    devices.value.filter((device) => device.hostId !== undefined && device.online === true && device.sync === undefined),
);

// Installing the sync agent out there is a download and a first pass over the folder, minutes rather than a switch
// being flipped, so the run is the ledger's, a row per device: closing Add device mid-install and opening it again
// finds the install still going (every Set up button held) and then what the device said, instead of a fresh offer.
// One at a time across the card, as before: `busy` is any of them.
const installs = useOperations<string>(`devices/desktop-sync/install`);
const installing = computed(() => installs.all.value.find((run) => run.state === `running`)?.tag);
// The newest install's end speaks for the card, as the one line under the buttons did.
const lastInstall = computed(() => installs.all.value.at(-1));
const installed = computed(() => (lastInstall.value?.state === `done` ? lastInstall.value.value : undefined));
const installError = computed(() => (lastInstall.value?.state === `failed` ? lastInstall.value.failure : undefined));

// Thrown by the task for a device that answered no, so the ledger keeps its words as the failure.
class InstallRefused extends Error {}

// The daemon mints the pairing and builds the line in that device's own shell dialect (hosts/device-commands.ts);
// this only says which device, which half, and which folder out there.
const installOn = async (device: Device): Promise<void> => {
    const id = device.hostId;
    if (id === undefined || installs.busy.value) {
        return;
    }
    const mode = portsOnly.value ? `mirror` : `sync`;
    const localDir = folder.value;
    const what = t(`sandbox.deviceOps.doingOn`, { doing: t(`sandbox.deviceOps.workingInstall`), machine: device.label });
    // A new press is the card's one answer line again, so an earlier device's outcome is put away first.
    for (const run of installs.all.value) {
        installs.dismiss(run.tag);
    }
    await installs.run(id, {
        what,
        // Which device, so the button under way is the one that spins.
        tag: id,
        // The device's own words either way: a refusal names the switch to flip rather than throwing.
        failed: (error): NoticeModel =>
            error instanceof InstallRefused
                ? { tone: `warning`, title: t(`sandbox.deviceOps.refusedInstall`), detail: error.message }
                : noticeFrom(error, t(`sandbox.deviceOps.unreachedInstall`), { tone: `warning` }),
        task: async () => {
            // The machine's card and the Devices tile carry it while the reader looks elsewhere.
            const endMark = beginDeviceWork({ machine: machineKeyOf(devices.value, device), doing: t(`sandbox.deviceOps.workingInstall`), what });
            try {
                const result = await runDeviceCommand(id, `sync-install`, { mode, ...(mode === `mirror` ? {} : { localDir }) });
                if (!result.ok) {
                    throw new InstallRefused(result.message);
                }
                return result.message;
            } finally {
                endMark();
                // The device's row is what confirms an enrollment, so ask for a fresh reading either way.
                refetch();
            }
        },
    });
};

// An operator's opt-in to ports-only (skip file sync, or mirror while another holds sync); forced on below maintainer,
// whose pairing the daemon caps at mirror anyway.
const mirrorOnly = ref(false);
const portsOnly = computed(() => !canOperate.value || mirrorOnly.value);

// Takeover and mirror setup are mutually exclusive forms: entering one leaves the other.
const startTakeover = (): void => {
    takeover.value = true;
    mirrorOnly.value = false;
};
const startMirror = (): void => {
    mirrorOnly.value = true;
    takeover.value = false;
};

// "What stays on your device" disclosure: collapsed by default.
const showFootprint = ref(false);

</script>

<template>
    <div class="@container">
        <div class="flex flex-col gap-4">
            <template v-if="available">
                <!-- States where status went, since this card no longer reports anything itself. -->
                <p class="text-2xs text-subtle">
                    {{ t(`sandbox.desktopSyncCard.pairAnotherDeviceSandbox`) }}
                    <b>{{ t(`sandbox.words.devicesSection`) }}</b> {{ t(`sandbox.desktopSyncCard.boardFolderPortsSwitches`) }}
                </p>
                <!-- Names the device being taken over, since taking over ends its sync. -->
                <p v-if="takeover" class="text-2xs text-warning">
                    {{ t(`sandbox.desktopSyncCard.takesOverFrom`, { device: holder?.label ?? t(`sandbox.desktopSyncCard.theOtherDevice`) }) }}
                </p>
                <p v-if="portsOnly && pairToken === undefined" class="text-2xs text-subtle">
                    <template v-if="canOperate">
                        {{ t(`sandbox.desktopSyncCard.portsOnlySandboxsDev`) }}
                    </template>
                    <template v-else>
                        {{ t(`sandbox.desktopSyncCard.collaboratorMirrorSandboxsDev`) }}
                    </template>
                </p>
                <div v-if="!portsOnly" class="flex flex-col gap-1.5">
                    <label class="text-2xs font-medium text-muted" for="desktop-sync-folder">{{ t(`sandbox.desktopSyncCard.localFolder`) }}</label>
                    <input id="desktop-sync-folder" v-model="folder" spellcheck="false" :class="ui.input({ size: `sm` }, 'w-full font-mono')" />
                </div>

                <template v-if="pairToken === undefined">
                    <!-- Machines this sandbox can already reach: the install runs out there over the connection they hold open, so no command is pasted anywhere. -->
                    <div v-if="candidates.length > 0 && !takeover" class="flex flex-col gap-1.5">
                        <div class="flex flex-wrap items-center gap-2">
                            <Button
                                v-for="device in candidates"
                                :key="device.key"
                                size="small"
                                :label="t(`sandbox.desktopSyncCard.setUpOn`, { label: device.label })"
                                :loading="installing === device.hostId"
                                :disabled="installs.busy.value"
                                @click="void installOn(device)"
                            >
                                <template #icon><Icon name="desktop" /></template>
                            </Button>
                        </div>
                        <p class="text-2xs text-subtle">
                            <template v-if="portsOnly">{{ t(`sandbox.desktopSyncCard.alreadyConnectedInstallsAgent`) }}</template>
                            <template v-else>
                                {{ t(`sandbox.desktopSyncCard.alreadyConnectedInstallsAgent2`) }}
                                <b>{{ t(`sandbox.desktopSyncCard.that`) }}</b> {{ t(`sandbox.desktopSyncCard.device`) }}
                            </template>
                        </p>
                        <Notice v-if="installError" :of="installError" class="text-2xs" />
                        <p v-else-if="installed" class="text-2xs text-muted">{{ installed }}</p>
                    </div>
                    <div class="flex flex-wrap items-center gap-3">
                        <Button
                            :label="
                                portsOnly
                                    ? t(`sandbox.desktopSyncCard.mirrorPortsToDevice`)
                                    : takeover
                                      ? t(`sandbox.desktopSyncCard.takeOverOnAnother`)
                                      : t(`sandbox.desktopSyncCard.enableDesktopSync`)
                            "
                            size="small"
                            :loading="minting"
                            @click="enable(portsOnly ? 'mirror' : 'sync')"
                        >
                            <template #icon><Icon name="desktop" /></template>
                        </Button>
                        <!-- Other mints are links, not buttons: only one enrollment is ever being set up at a time. -->
                        <button
                            v-if="canOperate && !takeover && !mirrorOnly && holder"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="startTakeover"
                        >
                            {{ t(`sandbox.desktopSyncCard.syncDifferentDeviceInstead`) }}
                        </button>
                        <button
                            v-if="canOperate && !takeover && !mirrorOnly"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="startMirror"
                        >
                            {{ t(`sandbox.desktopSyncCard.mirrorPortsOnlySkip`) }}
                        </button>
                        <button
                            v-else-if="canOperate && (mirrorOnly || takeover)"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="
                                mirrorOnly = false;
                                takeover = false;
                            "
                        >
                            {{ t(`ui.action.cancel`) }}
                        </button>
                    </div>
                </template>
                <template v-else>
                    <!-- Inside the desktop app the button opens a system folder dialog; the command below stays since the device being enrolled need not be this one. -->
                    <div v-if="desktopVersion() !== undefined && desktopLink !== undefined" class="flex flex-col gap-1.5">
                        <div>
                            <Button
                                :label="
                                    pairMode === 'mirror'
                                        ? t(`sandbox.desktopSyncCard.mirrorPortsToDevice2`)
                                        : t(`sandbox.desktopSyncCard.chooseFolderOnDevice`)
                                "
                                size="small"
                                @click="openDesktopLink(desktopLink)"
                            >
                                <template #icon><Icon name="desktop" /></template>
                            </Button>
                        </div>
                        <p class="text-2xs text-subtle">
                            <template v-if="pairMode === 'mirror'">
                                {{ t(`sandbox.desktopSyncCard.enrollsDevicePutsSandboxs`) }}
                            </template>
                            <template v-else> {{ t(`sandbox.desktopSyncCard.pickFolderInSystem`) }} </template>
                        </p>
                    </div>
                    <p class="text-2xs text-subtle">
                        <template v-if="desktopVersion() !== undefined && desktopLink !== undefined">
                            {{
                                t(`sandbox.desktopSyncCard.orRunThisOn`, {
                                    device:
                                        pairMode === `mirror`
                                            ? t(`sandbox.desktopSyncCard.deviceThatGetsPorts`)
                                            : t(`sandbox.desktopSyncCard.anotherDevice`),
                                })
                            }}
                        </template>
                        <template v-else-if="pairMode === 'mirror'">
                            {{ t(`sandbox.desktopSyncCard.runOnDeviceShould`) }}
                        </template>
                        <template v-else>
                            {{ t(`sandbox.desktopSyncCard.runOnDeviceInstalls`) }}
                        </template>
                    </p>
                    <RunCommand
                        v-if="command !== undefined"
                        :command="command"
                        source-switch
                        :expires-at="pairExpiresAt"
                        :renewing="minting"
                        @renew="enable(pairMode ?? 'sync')"
                    />
                    <!-- The command is kept until put away, since closing the dialog is not the same as having pasted it. -->
                    <p class="flex flex-wrap items-center gap-3 text-2xs text-subtle">
                        <button type="button" class="text-link hover:underline" @click="showFootprint = !showFootprint">
                            {{ t(`sandbox.desktopSyncCard.whatStaysOnDevice`) }}
                        </button>
                        <button type="button" class="text-link hover:underline" @click="forget">{{ t(`ui.action.done`) }}</button>
                    </p>
                    <ul v-if="showFootprint" class="flex list-disc flex-col gap-1 rounded-lg bg-canvas py-2.5 pl-7 pr-3 text-2xs text-subtle">
                        <li>{{ t(`sandbox.desktopSyncCard.agentMutagenCloudflaredUnder`) }} <span class="font-mono">~/.intentic/machine</span>.</li>
                        <li>{{ t(`sandbox.desktopSyncCard.sshKeySandboxTunnel`) }} <span class="font-mono">~/.ssh/config</span>.</li>
                        <li>
                            {{ t(`sandbox.desktopSyncCard.backgroundPortMirrorWatcher`) }}
                        </li>
                        <li>
                            <span class="font-mono text-content">intentic-machine sync uninstall</span>
                            {{ t(`sandbox.desktopSyncCard.removesAllDevices`) }} <b>{{ t(`sandbox.words.unpair`) }}</b>
                            {{ t(`sandbox.desktopSyncCard.buttonAsksToDo`) }}
                        </li>
                    </ul>
                </template>
                <Notice v-if="mintFailure" :of="mintFailure" class="text-2xs" />
            </template>

            <!-- Asked and not yet answered: neither the offer nor the refusal, which used to show first and then be contradicted. -->
            <p v-else-if="available === undefined && statusError !== undefined" class="text-2xs text-danger">
                {{ t(`sandbox.desktopSyncCard.couldntCheckSync`, { reason: statusError }) }}
            </p>
            <p v-else-if="available === undefined" class="text-2xs text-subtle">{{ t(`sandbox.desktopSyncCard.checkingSync`) }}</p>

            <!-- No SSH way in on a loopback/preview sandbox or one behind intentic's own tunnels (web traffic only): sync has nothing to ride. -->
            <div v-else :class="ui.emptyState()">
                {{ t(`sandbox.desktopSyncCard.desktopSyncNeedsSsh`) }}
            </div>
        </div>
    </div>
</template>
