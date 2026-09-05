<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, ui, Code, RowGroup, RowNote } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDevices } from "../../composables/sandbox/useDevices";
import { useDesktopSync } from "../../composables/sandbox/useDesktopSync";
import { desktopVersion, openDesktopLink } from "../../environments/desktop";
import ScriptSourceSwitch from "../../components/ScriptSourceSwitch.vue";

/* ADDING A DEVICE TO THIS SANDBOX. Pick a folder, click Enable, paste the one-liner it reveals on the machine
 * you want. That one-liner installs the resident agent and enrolls it, no Google sign-in on the laptop.
 *
 * ONE JOB, WHICH IS THE CHANGE. This card used to hold the whole subject: "Syncing from radarsu-rog", the folder
 * on that machine, a warning when it went quiet, and a "Disable sync" that revoked EVERY paired device at
 * once. All of it in the singular, under a list of the several devices that could disagree with it, because
 * the daemon published its enrollment list flattened into one holder and some names.
 *
 * Every one of those facts is per DEVICE, so every one of them is now a row in the Devices list above, with
 * its switches beside it: pause under the folder, mirroring under the ports, unpair and revoke on the machine.
 * What is left here is the one thing that genuinely belongs to the sandbox rather than to any device, because
 * it happens BEFORE there is a device to put it on: minting the pairing.
 *
 * Two enrollment modes still surface here: full "sync" (file sync + ports, single holder, owner-only) and
 * "mirror" (ports only, any number of machines). An owner can pick either — including mirroring a second
 * device while their first holds sync; a member only ever sees the mirror flow, matching what the daemon would
 * grant them. */

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

/* WHETHER A DEVICE ALREADY HOLDS FILE SYNC, read off the LIST rather than off a status call of this card's
 * own. File sync is single-holder, so enrolling a second machine for it is a takeover, and the reader has to be
 * told whose. That fact used to arrive here as `syncingFrom` on /system/sync, which is the sandbox-level shape
 * this page stopped having; it is a property of one of the rows above, so it is read from there.
 *
 * Not polling: the list above this card is doing that already (same query, same cache), and a card deciding
 * which words to use is not a reason to reach out to somebody's laptop on a timer. */
const { devices } = useDevices({ poll: false });
const holder = computed<Device | undefined>(() => devices.value.find((device) => device.sync?.mode === `sync`));

// The owner's opt-in to the ports-only flow (skip file sync, or add a mirror machine while another holds sync).
// Members don't need the toggle: portsOnly is forced for them.
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

// "What stays on your device" disclosure: collapsed by default, but always one click away before pasting.
const showFootprint = ref(false);

// Brief ring when the user arrives here from the Workspace "Open in local editor" shortcut.
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
                <!-- WHAT THIS CARD IS FOR, in one line, because it no longer reports anything and a reader who
                     arrives expecting the old status card should be told where that went. -->
                <p class="text-2xs text-subtle">
                    Pair another device with this sandbox. Anything already paired is a row in
                    <b>Devices</b> above, with its folder, its ports and its switches.
                </p>
                <!-- Taking file sync over from the machine that holds it. Offered only when one does, and it
                     names it: this ends that device's sync, which is the whole reason it is opt-in rather
                     than what Enable quietly does. -->
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
                        <!-- WHAT ELSE THIS CARD CAN MINT, as links rather than a second row of buttons: each is
                             a different enrollment, and only ever one of them is being set up at a time.
                             Takeover appears only while a machine actually holds file sync, because it is
                             meaningless otherwise and its warning names that machine. -->
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
                    <!-- Inside the desktop app, the no-terminal way leads: the app asks for the folder in a
                         system dialog (no path to type, no ~ to expand) and runs the same script the command
                         below runs. The command keeps its place underneath because the device being
                         enrolled need not be this one. -->
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
                    <!-- Both forms are on screen at once here, and the switch rewrites the pair, so it sits
                         above them rather than beside either. The device being enrolled is by definition not
                         the sandbox's own machine, and need not be the developer's. -->
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

            <!-- No SSH way in: a loopback/preview sandbox, or one reached over intentic's own tunnels, which carry
                 web traffic only for now. Either way sync has nothing to ride, and saying so beats an Enable button
                 whose one-liner would hang on the laptop. -->
            <div v-else :class="ui.emptyState()">
                Desktop sync needs an SSH way into this sandbox. Sandboxes we connect for you don't have one yet, but one behind your own domain does.
            </div>
        </RowNote>
    </RowGroup>
</template>
