<script setup lang="ts">
import { Card, cmp, Code } from "@intentic/ui";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDesktopSync } from "../../composables/sandbox/useDesktopSync";
import ScriptSourceSwitch from "../../components/ScriptSourceSwitch.vue";

/* Desktop sync enablement (on the /sandbox hub). Three states over useDesktopSync: pick a folder and Enable →
 * copy-paste one-liner carrying a single-use pairing token → "enabled" once the daemon reports the key enrolled.
 * No Google sign-in on the laptop; reuses the shared Code + status-pill markup. The card is explicit that the
 * one-liner installs a resident agent doing TWO things — file sync and localhost port mirroring — and that
 * Disable revokes access but leaves the agent installed (`intentic-sync uninstall` removes it).
 *
 * Two enrollment modes surface here: full "sync" (file sync + ports, single holder, owner-only) and "mirror"
 * (ports only, any number of machines). An owner can pick either — including mirroring a second computer while
 * their first holds sync; a member only ever sees the mirror flow, matching what the daemon would grant them. */

const { highlight = false } = defineProps<{ highlight?: boolean }>();

const {
    isOwner,
    enrolled,
    syncingFrom,
    syncStopped,
    syncLastSeen,
    revokedFrom,
    available,
    folder,
    pairToken,
    pairMode,
    minting,
    takeover,
    linuxCommand,
    windowsCommand,
    enable,
    start,
    stop,
    disable,
} = useDesktopSync();

// The owner's opt-in to the ports-only flow (skip file sync on a fresh enable, or add a mirror machine while
// another holds sync). Members don't need the toggle: portsOnly is forced for them.
const mirrorOnly = ref(false);
const portsOnly = computed(() => !isOwner.value || mirrorOnly.value);

// Takeover and mirror setup are mutually exclusive forms — entering one leaves the other.
const startTakeover = (): void => {
    takeover.value = true;
    mirrorOnly.value = false;
};
const startMirror = (): void => {
    mirrorOnly.value = true;
    takeover.value = false;
};

// "What stays on your computer" disclosure — collapsed by default, but always one click away before pasting.
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

const disabling = ref(false);
const runDisable = async (): Promise<void> => {
    disabling.value = true;
    try {
        await disable();
    } finally {
        disabling.value = false;
    }
};

onMounted(start);
onUnmounted(stop);
</script>

<template>
    <Card id="desktop-sync" class="flex flex-col gap-4 transition-shadow" :class="ringing ? 'ring-2 ring-info' : ''">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-2.5">
                <Icon name="sync" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Desktop sync</h2>
                    <p class="text-2xs text-subtle">
                        <template v-if="isOwner">
                            Edit your sandbox in your own editor, and reach its dev servers on your own localhost — same ports, cookies, and CORS.
                        </template>
                        <template v-else>Mirror this sandbox's dev servers onto your own localhost — same ports, cookies, and CORS.</template>
                    </p>
                </div>
            </div>
            <!-- The pill follows the HEARTBEAT, not the enrollment record: a green "Enabled" over a machine that
                 stopped polling hours ago is the exact lie that let a lost pairing go unnoticed. -->
            <span
                v-if="enrolled"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                :class="syncStopped ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'"
            >
                <span class="h-1.5 w-1.5 rounded-full" :class="syncStopped ? 'bg-warning' : 'bg-success'"></span>
                {{ syncStopped ? "Not syncing" : "Enabled" }}
            </span>
        </div>

        <template v-if="available">
            <!-- Enabled: a machine holds sync. Show which, how to manage it, and an opt-in to move it here. -->
            <template v-if="enrolled">
                <dl class="flex flex-col gap-1.5 rounded-lg bg-canvas px-3 py-2.5 text-2xs">
                    <div v-if="syncingFrom !== undefined" class="flex items-center justify-between gap-3">
                        <dt class="text-subtle">{{ syncStopped ? "Last synced from" : "Syncing from" }}</dt>
                        <dd class="flex min-w-0 items-center gap-1.5">
                            <span class="truncate font-mono text-content">{{ syncingFrom }}</span>
                            <span v-if="syncLastSeen !== undefined" :class="syncStopped ? 'text-warning' : 'text-subtle'">{{ syncLastSeen }}</span>
                        </dd>
                    </div>
                </dl>
                <!-- The "Ports: on localhost at <machine>" and "Manage: intentic-sync status" rows that used to
                     sit here are gone. Both were this card admitting it could not answer: the first named a
                     machine instead of the ports, and the second named a terminal command. The Computers list
                     above states each of them as a fact the machine reported, so repeating them here would be two
                     vaguer copies of what the reader has already scrolled past. -->
                <p class="text-2xs text-subtle">Folders, ports and agent health for every paired computer are listed above.</p>
                <!-- The holder went quiet. Name the likeliest cause first: on a computer running more than one
                     sandbox, the agent is shared, and older builds silently handed the whole pairing to whichever
                     sandbox was set up last — so a folder stops syncing with nothing on either end saying so. -->
                <div v-if="syncStopped" class="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-2xs text-warning">
                    <p class="font-medium">
                        <span class="font-mono">{{ syncingFrom }}</span> hasn't checked in since {{ syncLastSeen ?? "it was enrolled" }}.
                    </p>
                    <p>
                        Nothing is reaching its folder. That computer may be asleep or offline — or its sync agent was pointed at a different sandbox.
                        Run <span class="font-mono">intentic-sync status</span> there to see every sandbox it pairs, then re-enable below if this one
                        is missing.
                    </p>
                </div>
                <div v-if="isOwner" class="flex items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <button
                            v-if="!takeover && pairToken === undefined"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="startTakeover"
                        >
                            Sync from this computer instead
                        </button>
                        <button
                            v-if="!portsOnly && pairToken === undefined"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="startMirror"
                        >
                            Mirror ports on another computer
                        </button>
                    </div>
                    <Button label="Disable sync" size="small" severity="danger" :text="true" :loading="disabling" @click="runDisable">
                        <template #icon><Icon name="times" /></template>
                    </Button>
                </div>
            </template>

            <!-- Setup: fresh enable, takeover (move an active sync here), or a mirror-only enrollment (always
                 addable — mirrors don't contend). Pick a folder (sync only), reveal the one-liner. -->
            <template v-if="!enrolled || takeover || portsOnly">
                <!-- Just disabled: revoking stops the agent's access (its watcher shuts down on its own), but the
                     installation stays until uninstall runs on that machine. -->
                <p v-if="!enrolled && revokedFrom !== undefined" class="text-2xs text-subtle">
                    Access for <span class="font-mono text-content">{{ revokedFrom }}</span> is revoked — its port mirroring stops by itself within a
                    minute. To remove the agent from that computer, run <span class="font-mono text-content">intentic-sync uninstall</span> there.
                </p>
                <p v-if="takeover" class="text-2xs text-warning">
                    This takes over from {{ syncingFrom ?? "the other computer" }} — its sync stops when you run the command below.
                </p>
                <p v-if="portsOnly && pairToken === undefined" class="text-2xs text-subtle">
                    <template v-if="isOwner">
                        Ports only: the sandbox's dev servers appear on the enrolling computer's localhost — no files are synced.
                    </template>
                    <template v-else>
                        As a collaborator, you can mirror the sandbox's dev servers onto your own localhost — live previews without file access beyond
                        what the workspace already shows. Files aren't synced.
                    </template>
                </p>
                <div v-if="!portsOnly" class="flex flex-col gap-1.5">
                    <label class="text-2xs font-medium text-muted" for="desktop-sync-folder">Local folder</label>
                    <InputText id="desktop-sync-folder" v-model="folder" class="w-full font-mono text-xs" spellcheck="false" />
                </div>

                <template v-if="pairToken === undefined">
                    <div class="flex flex-wrap items-center gap-3">
                        <Button
                            :label="portsOnly ? 'Mirror ports to this computer' : takeover ? 'Take over on this computer' : 'Enable desktop sync'"
                            size="small"
                            :loading="minting"
                            @click="enable(portsOnly ? 'mirror' : 'sync')"
                        >
                            <template #icon><Icon name="desktop" /></template>
                        </Button>
                        <button
                            v-if="isOwner && !takeover && !mirrorOnly && !enrolled"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="startMirror"
                        >
                            Mirror ports only (skip file sync)
                        </button>
                        <button
                            v-else-if="isOwner && mirrorOnly"
                            type="button"
                            class="text-2xs text-link hover:underline"
                            @click="mirrorOnly = false"
                        >
                            {{ enrolled ? "Cancel" : "Include file sync instead" }}
                        </button>
                    </div>
                </template>
                <template v-else>
                    <p class="text-2xs text-subtle">
                        <template v-if="pairMode === 'mirror'">
                            Run this on the computer that should get the ports. It installs the sync agent and mirrors the sandbox's dev servers onto
                            its localhost — no files are synced, no sign-in needed.
                        </template>
                        <template v-else>
                            Run this on your computer. It installs the sync agent and starts two things — file sync, and a port mirror that puts the
                            sandbox's dev servers on your localhost — no sign-in needed.
                        </template>
                    </p>
                    <!-- Both forms are on screen at once here, and the switch rewrites the pair — so it sits
                         above them rather than beside either. The computer being enrolled is by definition not
                         the sandbox's own machine, and need not be the developer's. -->
                    <ScriptSourceSwitch />
                    <Code :code="linuxCommand" lang="bash" label="Linux / macOS" :wrap="true" />
                    <Code :code="windowsCommand" lang="powershell" label="Windows (PowerShell)" :wrap="true" />
                    <p class="text-2xs text-subtle">
                        This command is single-use and expires in ~10 minutes.
                        <button type="button" class="text-link hover:underline" @click="enable(pairMode ?? 'sync')">Regenerate</button>
                        ·
                        <button type="button" class="text-link hover:underline" @click="showFootprint = !showFootprint">
                            What stays on your computer?
                        </button>
                    </p>
                    <ul v-if="showFootprint" class="flex list-disc flex-col gap-1 rounded-lg bg-canvas py-2.5 pl-7 pr-3 text-2xs text-subtle">
                        <li>The sync agent, Mutagen, and cloudflared under <span class="font-mono">~/.intentic/sync</span>.</li>
                        <li>An SSH key for the sandbox tunnel, plus one include line in <span class="font-mono">~/.ssh/config</span>.</li>
                        <li>
                            A background port-mirror watcher, registered to resume at login (launchd / the Windows Run key / XDG autostart) so
                            localhost ports survive reboots.
                        </li>
                        <li>
                            <span class="font-mono text-content">intentic-sync uninstall</span> removes all of it; disabling sync here also makes the
                            watcher shut itself down.
                        </li>
                    </ul>
                </template>
            </template>
        </template>

        <!-- Sandbox has no SSH tunnel (loopback/preview) — sync can't reach it. -->
        <div v-else :class="cmp.emptyState()">Desktop sync becomes available once your sandbox is connected over its tunnel.</div>
    </Card>
</template>
