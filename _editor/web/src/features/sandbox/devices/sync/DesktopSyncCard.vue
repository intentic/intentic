<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, ui, Code, Notice } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { runDeviceCommand, useDevices } from "../useDevices";
import { useDesktopSync } from "./useDesktopSync";
import { useHubWork } from "../../../../shell/hub/hubWork";
import { desktopVersion, openDesktopLink } from "../../../../app/environments/desktop";
import ScriptSourceSwitch from "../../../capabilities/connect/ScriptSourceSwitch.vue";
import { useT } from "@intentic/ui/i18n";

// Mints a device pairing: pick a folder, click Enable, run the one-liner on the target machine. Two modes:
// full sync (file sync + ports, single holder, owner-only) and mirror (ports only, any device). Body only:
// <AddDeviceDialog> frames it, so this draws no heading of its own.

const t = useT();

const { canOperate, available, folder, pairToken, pairMode, minting, takeover, linuxCommand, windowsCommand, desktopLink, enable, start, stop } =
    useDesktopSync();

// Whether a device holds file sync, read off the already-fetched devices list (same query, no extra poll).
const { devices, refetch } = useDevices({ poll: false });
const holder = computed<Device | undefined>(() => devices.value.find((device) => device.sync?.mode === `sync`));

// Machines already connected as devices and answering right now: the install can be RUN on them from here, so
// there is nothing to paste. One already enrolled with this sandbox is not a candidate — its own row on the
// Devices board owns everything about that pairing.
const candidates = computed(() =>
    devices.value.filter((device) => device.hostId !== undefined && device.online === true && device.sync === undefined),
);

const hubWork = useHubWork();

const installing = ref<string | undefined>(undefined);
const installed = ref<string | undefined>(undefined);
const installError = ref<string | undefined>(undefined);

// The daemon mints the pairing and builds the line in that device's own shell dialect (hosts/device-commands.ts);
// this only says which device, which half, and which folder out there.
const installOn = async (device: Device): Promise<void> => {
    const id = device.hostId;
    if (id === undefined || installing.value !== undefined) {
        return;
    }
    installing.value = id;
    installed.value = undefined;
    installError.value = undefined;
    // Installing the sync agent out there is a download and a first pass over the folder, not a switch being
    // flipped, so the Devices row carries it while the reader looks elsewhere.
    const endMark = hubWork.begin(`Setting file syncing up on ${device.label}`);
    try {
        const result = await runDeviceCommand(id, `sync-install`, {
            mode: portsOnly.value ? `mirror` : `sync`,
            ...(portsOnly.value ? {} : { localDir: folder.value }),
        });
        // The device's own words either way: a refusal names the switch to flip rather than throwing.
        installed.value = result.ok ? result.message : undefined;
        installError.value = result.ok ? undefined : result.message;
    } catch (error) {
        installError.value = error instanceof Error ? error.message : String(error);
    } finally {
        installing.value = undefined;
        endMark();
        // The device's row is what confirms an enrollment, so ask for a fresh reading either way.
        refetch();
    }
};

// Owner's opt-in to ports-only (skip file sync, or mirror while another holds sync); forced on for members.
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

onMounted(start);
onUnmounted(stop);
</script>

<template>
    <div class="@container">
        <div class="flex flex-col gap-4">
            <template v-if="available">
                <!-- States where status went, since this card no longer reports anything itself. -->
                <p class="text-2xs text-subtle">
                    {{ t(`sandbox.desktopSyncCard.pairAnotherDeviceSandbox`) }}
                    <b>{{ t(`shared.devices2`) }}</b> {{ t(`sandbox.desktopSyncCard.boardFolderPortsSwitches`) }}
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
                    <input id="desktop-sync-folder" v-model="folder" spellcheck="false" :class="ui.inputSm('w-full font-mono')" />
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
                                :disabled="installing !== undefined"
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
                        <Notice v-if="installError" tone="warning" class="text-2xs">{{ installError }}</Notice>
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
                    <!-- Both forms share the switch above them since it rewrites the pair; the device being enrolled need not be this one either. -->
                    <ScriptSourceSwitch />
                    <Code :code="linuxCommand" lang="bash" :label="t(`shared.linuxMacos`)" :wrap="true" />
                    <Code :code="windowsCommand" lang="powershell" :label="t(`sandbox.desktopSyncCard.windowsPowershell`)" :wrap="true" />
                    <p class="text-2xs text-subtle">
                        {{ t(`sandbox.desktopSyncCard.commandSingleUseExpires`) }}
                        <button type="button" class="text-link hover:underline" @click="enable(pairMode ?? 'sync')">
                            {{ t(`sandbox.desktopSyncCard.regenerate`) }}
                        </button>
                        ·
                        <button type="button" class="text-link hover:underline" @click="showFootprint = !showFootprint">
                            {{ t(`sandbox.desktopSyncCard.whatStaysOnDevice`) }}
                        </button>
                    </p>
                    <ul v-if="showFootprint" class="flex list-disc flex-col gap-1 rounded-lg bg-canvas py-2.5 pl-7 pr-3 text-2xs text-subtle">
                        <li>{{ t(`sandbox.desktopSyncCard.agentMutagenCloudflaredUnder`) }} <span class="font-mono">~/.intentic/machine</span>.</li>
                        <li>{{ t(`sandbox.desktopSyncCard.sshKeySandboxTunnel`) }} <span class="font-mono">~/.ssh/config</span>.</li>
                        <li>
                            {{ t(`sandbox.desktopSyncCard.backgroundPortMirrorWatcher`) }}
                        </li>
                        <li>
                            <span class="font-mono text-content">intentic-machine sync uninstall</span>
                            {{ t(`sandbox.desktopSyncCard.removesAllDevices`) }} <b>{{ t(`shared.unpair`) }}</b>
                            {{ t(`sandbox.desktopSyncCard.buttonAsksToDo`) }}
                        </li>
                    </ul>
                </template>
            </template>

            <!-- No SSH way in on a loopback/preview sandbox or one behind intentic's own tunnels (web traffic only): sync has nothing to ride. -->
            <div v-else :class="ui.emptyState()">
                {{ t(`sandbox.desktopSyncCard.desktopSyncNeedsSsh`) }}
            </div>
        </div>
    </div>
</template>
