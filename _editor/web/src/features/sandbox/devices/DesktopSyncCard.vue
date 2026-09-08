<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, ui, Code, RowGroup, RowNote } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDevices } from "./useDevices";
import { useDesktopSync } from "./useDesktopSync";
import { desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import ScriptSourceSwitch from "../../capabilities/connect/ScriptSourceSwitch.vue";

// Mints a device pairing: pick a folder, click Enable, run the one-liner on the target machine. Two modes:
// full sync (file sync + ports, single holder, owner-only) and mirror (ports only, any device).

const { highlight = false } = defineProps<{ highlight?: boolean }>();

const {
    canOperate,
    available,
    folder,
    pairToken,
    pairMode,
    minting,
    takeover,
    linuxCommand,
    windowsCommand,
    desktopLink,
    enable,
    start,
    stop,
} = useDesktopSync();

// Whether a device holds file sync, read off the already-fetched devices list (same query, no extra poll).
const { devices } = useDevices({ poll: false });
const holder = computed<Device | undefined>(() => devices.value.find((device) => device.sync?.mode === `sync`));

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

// Brief ring when arriving via the Workspace "Open in local editor" shortcut.
const ringing = ref(false);
watch(
    () => highlight,
    (on) => {
        if (!on) {
            return;
        }
        ringing.value = true;
        setTimeout(() => (ringing.value = false), 2500);
    },
    { immediate: true },
);

onMounted(start);
onUnmounted(stop);
</script>

<template>
    <RowGroup
        id="desktop-sync"
        label="Add a device"
        class="@container transition-shadow"
        :class="ringing ? '-m-1 rounded-xl p-1 ring-2 ring-info' : ''"
    >
        <RowNote variant="block" class="flex flex-col gap-4">
            <template v-if="available">
                <!-- States where status went, since this card no longer reports anything itself. -->
                <p class="text-2xs text-subtle">
                    Pair another device with this sandbox. Anything already paired is a row in
                    <b>Devices</b> above, with its folder, its ports and its switches.
                </p>
                <!-- Names the device being taken over, since taking over ends its sync. -->
                <p v-if="takeover" class="text-2xs text-warning">
                    This takes over from {{ holder?.label ?? "the other device" }}. Its file sync stops when you run the command below.
                </p>
                <p v-if="portsOnly && pairToken === undefined" class="text-2xs text-subtle">
                    <template v-if="canOperate">
                        Ports only: the sandbox's dev servers appear on the enrolling device's localhost. No files are synced.
                    </template>
                    <template v-else>
                        As a collaborator, you can mirror the sandbox's dev servers onto your own localhost for live previews. No files are synced
                        beyond what the workspace already shows.
                    </template>
                </p>
                <div v-if="!portsOnly" class="flex flex-col gap-1.5">
                    <label class="text-2xs font-medium text-muted" for="desktop-sync-folder">Local folder</label>
                    <input id="desktop-sync-folder" v-model="folder" spellcheck="false" :class="ui.inputSm('w-full font-mono')" />
                </div>

                <template v-if="pairToken === undefined">
                    <div class="flex flex-wrap items-center gap-3">
                        <Button
                            :label="portsOnly ? 'Mirror ports to a device' : takeover ? 'Take over on another device' : 'Enable desktop sync'"
                            size="small"
                            :loading="minting"
                            @click="enable(portsOnly ? 'mirror' : 'sync')"
                        >
                            <template #icon><Icon name="desktop" /></template>
                        </Button>
                        <!--
                            Other mints are links, not buttons: only one enrollment is ever being set up at a time. Takeover shows only
                            while a machine holds file sync.
                        -->
                        <button
                            v-if="canOperate && !takeover && !mirrorOnly && holder"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="startTakeover"
                        >
                            Sync from a different device instead
                        </button>
                        <button
                            v-if="canOperate && !takeover && !mirrorOnly"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="startMirror"
                        >
                            Mirror ports only (skip file sync)
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
                            Cancel
                        </button>
                    </div>
                </template>
                <template v-else>
                    <!--
                        Inside the desktop app the button opens a system folder dialog; the command below stays since the device
                        being enrolled need not be this one.
                    -->
                    <div v-if="desktopVersion() !== undefined && desktopLink !== undefined" class="flex flex-col gap-1.5">
                        <div>
                            <Button
                                :label="pairMode === 'mirror' ? 'Mirror ports to this device' : 'Choose a folder on this device'"
                                size="small"
                                @click="openDesktopLink(desktopLink)"
                            >
                                <template #icon><Icon name="desktop" /></template>
                            </Button>
                        </div>
                        <p class="text-2xs text-subtle">
                            <template v-if="pairMode === 'mirror'">
                                Enrolls this device and puts the sandbox's dev servers on its localhost. No files are synced.
                            </template>
                            <template v-else> Pick the folder in a system dialog: it and the sandbox's files then stay in step, both ways. </template>
                        </p>
                    </div>
                    <p class="text-2xs text-subtle">
                        <template v-if="desktopVersion() !== undefined && desktopLink !== undefined">
                            Or run this on {{ pairMode === "mirror" ? "the device that should get the ports" : "another device" }}:
                        </template>
                        <template v-else-if="pairMode === 'mirror'">
                            Run this on the device that should get the ports. It installs the agent and mirrors the sandbox's dev servers onto
                            its localhost. No files are synced, and no sign-in is needed.
                        </template>
                        <template v-else>
                            Run this on your device. It installs the agent and starts two things: file sync, and a port mirror that puts the
                            sandbox's dev servers on your localhost. No sign-in is needed.
                        </template>
                    </p>
                    <!--
                        Both forms share the switch above them since it rewrites the pair; the device being enrolled need not be
                        this one either.
                    -->
                    <ScriptSourceSwitch />
                    <Code :code="linuxCommand" lang="bash" label="Linux / macOS" :wrap="true" />
                    <Code :code="windowsCommand" lang="powershell" label="Windows (PowerShell)" :wrap="true" />
                    <p class="text-2xs text-subtle">
                        This command is single-use and expires in ~10 minutes.
                        <button type="button" class="text-link hover:underline" @click="enable(pairMode ?? 'sync')">Regenerate</button>
                        ·
                        <button type="button" class="text-link hover:underline" @click="showFootprint = !showFootprint">
                            What stays on your device?
                        </button>
                    </p>
                    <ul v-if="showFootprint" class="flex list-disc flex-col gap-1 rounded-lg bg-canvas py-2.5 pl-7 pr-3 text-2xs text-subtle">
                        <li>The agent, Mutagen, and cloudflared under <span class="font-mono">~/.intentic/machine</span>.</li>
                        <li>An SSH key for the sandbox tunnel, plus one include line in <span class="font-mono">~/.ssh/config</span>.</li>
                        <li>
                            A background port-mirror watcher, registered to resume at login (launchd / the Windows Run key / XDG autostart) so
                            localhost ports survive reboots.
                        </li>
                        <li>
                            <span class="font-mono text-content">intentic-machine sync uninstall</span> removes all of it; that device's
                            <b>Unpair</b> button above asks it to do exactly that.
                        </li>
                    </ul>
                </template>
            </template>

            <!--
                No SSH way in on a loopback/preview sandbox or one behind intentic's own tunnels (web traffic only): sync
                has nothing to ride.
            -->
            <div v-else :class="ui.emptyState()">
                Desktop sync needs an SSH way into this sandbox. Sandboxes we connect for you don't have one yet, but one behind your own domain does.
            </div>
        </RowNote>
    </RowGroup>
</template>
