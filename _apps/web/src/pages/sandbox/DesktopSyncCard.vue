<script setup lang="ts">
import { Card, cmp, Code } from "@intentic-app/ui";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDesktopSync } from "../../composables/sandbox/useDesktopSync";

/* Desktop sync enablement (on the /sandbox hub). Three states over useDesktopSync: pick a folder and Enable →
 * copy-paste one-liner carrying a single-use pairing token → "enabled" once the daemon reports the key enrolled.
 * No Google sign-in on the laptop; reuses the shared Code + status-pill markup. The card is explicit that the
 * one-liner installs a resident agent doing TWO things — file sync and localhost port mirroring — and that
 * Disable revokes access but leaves the agent installed (`intentic-sync uninstall` removes it). */

const { highlight = false } = defineProps<{ highlight?: boolean }>();

const {
    enrolled,
    syncingFrom,
    mirroredBy,
    revokedFrom,
    available,
    folder,
    pairToken,
    minting,
    takeover,
    linuxCommand,
    windowsCommand,
    enable,
    start,
    stop,
    disable,
} = useDesktopSync();

// Every machine with the sandbox's ports on its localhost: the sync holder mirrors too, plus any mirror-only
// collaborators — so an active localhost forward is never invisible here.
const portMachines = computed(() => {
    const machines = [...(syncingFrom.value === undefined ? [] : [syncingFrom.value]), ...mirroredBy.value];
    return machines.length > 0 ? machines.join(", ") : "the enrolled computer";
});

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
                        Edit your sandbox in your own editor, and reach its dev servers on your own localhost — same ports, cookies, and CORS.
                    </p>
                </div>
            </div>
            <span
                v-if="enrolled"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success"
            >
                <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
                Enabled
            </span>
        </div>

        <template v-if="available">
            <!-- Enabled: a machine holds sync. Show which, how to manage it, and an opt-in to move it here. -->
            <template v-if="enrolled">
                <dl class="flex flex-col gap-1.5 rounded-lg border border-line bg-overlay/40 px-3 py-2.5 text-2xs">
                    <div v-if="syncingFrom !== undefined" class="flex items-center justify-between gap-3">
                        <dt class="text-subtle">Syncing from</dt>
                        <dd class="truncate font-mono text-content">{{ syncingFrom }}</dd>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                        <dt class="text-subtle">Ports</dt>
                        <dd class="truncate text-content">
                            on <span class="font-mono">localhost</span> at <span class="font-mono">{{ portMachines }}</span>
                        </dd>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                        <dt class="text-subtle">Manage</dt>
                        <dd class="font-mono text-content">intentic-sync status</dd>
                    </div>
                </dl>
                <div class="flex items-center justify-between gap-2">
                    <button
                        v-if="!takeover && pairToken === undefined"
                        type="button"
                        class="text-2xs text-link hover:underline"
                        @click="takeover = true"
                    >
                        Sync from this computer instead
                    </button>
                    <span v-else></span>
                    <Button label="Disable sync" size="small" severity="danger" :text="true" :loading="disabling" @click="runDisable">
                        <template #icon><Icon name="times" /></template>
                    </Button>
                </div>
            </template>

            <!-- Setup (fresh enable) or takeover (move an active sync here): pick a folder, reveal the one-liner. -->
            <template v-if="!enrolled || takeover">
                <!-- Just disabled: revoking stops the agent's access (its watcher shuts down on its own), but the
                     installation stays until uninstall runs on that machine. -->
                <p v-if="!enrolled && revokedFrom !== undefined" class="text-2xs text-subtle">
                    Access for <span class="font-mono text-content">{{ revokedFrom }}</span> is revoked — its port mirroring stops by itself within a
                    minute. To remove the agent from that computer, run <span class="font-mono text-content">intentic-sync uninstall</span> there.
                </p>
                <p v-if="takeover" class="text-2xs text-warning">
                    This takes over from {{ syncingFrom ?? "the other computer" }} — its sync stops when you run the command below.
                </p>
                <div class="flex flex-col gap-1.5">
                    <label class="text-2xs font-medium text-muted" for="desktop-sync-folder">Local folder</label>
                    <InputText id="desktop-sync-folder" v-model="folder" class="w-full font-mono text-xs" spellcheck="false" />
                </div>

                <template v-if="pairToken === undefined">
                    <Button
                        :label="takeover ? 'Take over on this computer' : 'Enable desktop sync'"
                        size="small"
                        :loading="minting"
                        class="self-start"
                        @click="enable"
                    >
                        <template #icon><Icon name="desktop" /></template>
                    </Button>
                </template>
                <template v-else>
                    <p class="text-2xs text-subtle">
                        Run this on your computer. It installs the sync agent and starts two things — file sync, and a port mirror that puts the
                        sandbox's dev servers on your localhost — no sign-in needed.
                    </p>
                    <Code :code="linuxCommand" lang="bash" label="Linux / macOS" :wrap="true" />
                    <Code :code="windowsCommand" lang="powershell" label="Windows (PowerShell)" :wrap="true" />
                    <p class="text-2xs text-subtle">
                        This command is single-use and expires in ~10 minutes.
                        <button type="button" class="text-link hover:underline" @click="enable">Regenerate</button>
                        ·
                        <button type="button" class="text-link hover:underline" @click="showFootprint = !showFootprint">
                            What stays on your computer?
                        </button>
                    </p>
                    <ul
                        v-if="showFootprint"
                        class="flex list-disc flex-col gap-1 rounded-lg border border-line bg-overlay/40 py-2.5 pl-7 pr-3 text-2xs text-subtle"
                    >
                        <li>The sync agent, Mutagen, and cloudflared under <span class="font-mono">~/.intentic/sync</span>.</li>
                        <li>An SSH key for the sandbox tunnel, plus one include line in <span class="font-mono">~/.ssh/config</span>.</li>
                        <li>
                            A background port-mirror watcher, registered to resume at login (launchd / Task Scheduler / XDG autostart) so localhost
                            ports survive reboots.
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
