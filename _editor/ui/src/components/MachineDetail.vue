<!-- WHAT ONE COMPUTER IS DOING FOR A SANDBOX — the folders it syncs, the ports it put on localhost, and whether
     the watcher behind both is alive.

     This is the BODY only, deliberately. The desktop app frames it as a section of its manager window and the web
     app frames it as an expanded row on the Computers tab; the chrome differs, and every fact inside it does not.
     Before this existed the same facts had exactly one rendering — `intentic-sync status`, on a terminal that the
     desktop app's whole premise is not needing.

     Props are STRUCTURAL rather than the sandbox contract's own types: `@intentic/ui` carries no domain
     dependency, and a MachineReport satisfies these by shape. `state` and `mode` are unions so a contract that
     grows a case fails at the call sites in the two apps — but every lookup below also has a fallback, because a
     row that renders as nothing is worse than a row that renders as itself. -->
<script lang="ts">
export interface MachinePortRow {
    port: number;
    sandboxId: string;
    state: `mirrored` | `held-by-sandbox` | `busy`;
    heldBy?: string | undefined;
    command?: string | undefined;
}

export interface MachineFolderRow {
    sandboxId: string;
    mode: `sync` | `mirror`;
    localDir?: string | undefined;
    mutagenStatus?: string | undefined;
    conflicts?: number | undefined;
    paused?: boolean | undefined;
}

export interface MachineWatcherState {
    running: boolean;
    pid?: number | undefined;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import StatusBadge, { type StatusVariant } from "./StatusBadge.vue";

const {
    pairings = [],
    ports = [],
    watcher,
} = defineProps<{
    pairings?: MachineFolderRow[];
    ports?: MachinePortRow[];
    watcher?: MachineWatcherState | undefined;
}>();

// A port that did not reach localhost is the row this view exists for, so the losers sort to the bottom rather
// than being dropped — and inside each group the number orders them, which is how people look a port up.
const orderedPorts = computed(() => ports.toSorted((a, b) => (a.state === b.state ? a.port - b.port : a.state === `mirrored` ? -1 : 1)));

const PORT_TONE: Record<string, StatusVariant> = {
    mirrored: `success`,
    "held-by-sandbox": `warning`,
    busy: `neutral`,
};

// Each non-mirrored state names a DIFFERENT remedy, which is the whole reason they are not one "unavailable":
// a contested port is fixed by unpairing a sandbox, a busy one by quitting whatever local process holds it.
const portReason = (port: MachinePortRow): string | undefined => {
    if (port.state === `mirrored`) {
        return undefined;
    }
    return port.heldBy === undefined ? `something else on this computer has this port` : `${port.heldBy} has it`;
};

/* What a file sync is doing, in Mutagen's own words. Not mapped onto a traffic light: its halted states name
 * their own cause ("halted-on-root-emptied"), and flattening them to "problem" sends the reader back to the
 * terminal this view replaces. Paused wins, because it is the one state the user chose. */
const folderState = (folder: MachineFolderRow): string | undefined => {
    if (folder.mode === `mirror`) {
        return `ports only`;
    }
    if (folder.paused === true) {
        return `paused`;
    }
    return folder.mutagenStatus;
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- The watcher first: it decides whether everything below it is still true. A healthy folder list under
             a dead watcher means new ports stop appearing and commits stop arriving, with every other row here
             reading exactly as it did the moment before. -->
        <div v-if="watcher" class="flex items-center gap-2 text-2xs">
            <StatusBadge
                :variant="watcher.running ? `success` : `warning`"
                :dot="true"
                size="xs"
                :label="watcher.running ? `Sync agent running` : `Sync agent stopped`"
            />
            <span v-if="!watcher.running" class="text-warning">
                Nothing is reaching this computer's folders or ports until it restarts —
                <span class="font-mono">intentic-sync mirror</span>
            </span>
            <span v-else-if="watcher.pid !== undefined" class="font-mono text-subtle">pid {{ watcher.pid }}</span>
        </div>

        <div v-if="pairings.length > 0" class="flex flex-col gap-1.5">
            <span class="text-2xs font-medium text-muted">Folders</span>
            <div v-for="folder in pairings" :key="folder.sandboxId" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs">
                <Icon :name="folder.mode === `sync` ? `sync` : `arrow-right`" class="shrink-0 text-subtle" />
                <!-- The answer to the question this whole view was built for: WHICH folder on that computer is
                     this sandbox's /work. The daemon never learns it (SYNC_DIR is the agent's own state), so
                     before the machine report there was nowhere in the product it could be read. -->
                <span v-if="folder.localDir" class="truncate font-mono text-content">{{ folder.localDir }}</span>
                <span v-else class="text-subtle">no folder synced</span>
                <span class="truncate text-subtle">{{ folder.sandboxId }}</span>
                <span v-if="folderState(folder)" class="text-subtle">· {{ folderState(folder) }}</span>
                <!-- Two-way-safe flags conflicts instead of clobbering, and nothing else in the product has ever
                     said one was waiting — so a file edited on both ends sat stuck with no way to find out. -->
                <span v-if="folder.conflicts" class="font-medium text-warning">· {{ folder.conflicts }} conflict(s)</span>
            </div>
        </div>

        <div v-if="orderedPorts.length > 0" class="flex flex-col gap-1.5">
            <span class="text-2xs font-medium text-muted">Ports on localhost</span>
            <div
                v-for="port in orderedPorts"
                :key="`${port.sandboxId}:${port.port}`"
                class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs"
            >
                <StatusBadge :variant="PORT_TONE[port.state] ?? `neutral`" size="xs" :label="`localhost:${port.port}`" />
                <span class="truncate text-subtle">{{ port.sandboxId }}</span>
                <span v-if="port.command" class="truncate font-mono text-subtle">{{ port.command }}</span>
                <span v-if="portReason(port)" class="text-warning">· not mirrored, {{ portReason(port) }}</span>
            </div>
        </div>

        <p v-if="pairings.length === 0 && orderedPorts.length === 0" class="text-2xs text-muted">
            This computer isn't syncing a folder or holding any ports for this sandbox.
        </p>
    </div>
</template>
