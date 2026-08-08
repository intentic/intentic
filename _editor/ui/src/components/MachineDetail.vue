<!-- WHAT ONE COMPUTER IS DOING FOR A SANDBOX — the folders it syncs, the ports it put on localhost, and whether
     the watcher behind both is alive.

     This is the BODY only, deliberately. The desktop app frames it as a section of its manager window and the web
     app frames it as an expanded row on the Computers tab; the chrome differs, and every fact inside it does not.
     Before this existed the same facts had exactly one rendering — `intentic-sync status`, on a terminal that the
     desktop app's whole premise is not needing.

     ONE BLOCK PER SANDBOX, which is the redesign. The report's own shape — a flat list of folders and a flat list
     of ports, each row carrying the sandbox it belongs to — was rendered straight through, so a machine serving
     two sandboxes drew six rows that each repeated a thirty-character id beside the path or port the reader
     actually came for, at the same size and nearly the same grey. Grouping says that id once and buys the rows a
     label column to align against, which is what turns "a paragraph of small text" into something scannable.

     Derivations live in machineDetail.ts, including the prop shapes: they are STRUCTURAL rather than the sandbox
     contract's own types (`@intentic/ui` carries no domain dependency) and a MachineReport satisfies them. -->
<script setup lang="ts">
import { computed } from "vue";
import CopyButton from "./CopyButton.vue";
import {
    folderState,
    folderTone,
    type MachineFolderRow,
    type MachinePortRow,
    type MachineWatcherState,
    portNote,
    sandboxGroups,
    shortCommand,
} from "./machineDetail.js";
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

const groups = computed(() => sandboxGroups(pairings, ports));

/* A PORT IS AN ADDRESS, NOT A STATUS, so it wears a chip of its own rather than a StatusBadge: monospaced, so
 * numbers line up down the column and 8788 cannot be misread as 8788o, and square, because the pill shape is
 * this app's word for a state. The tint is the outcome — green is a port you can open right now.
 *
 * And only a port that MADE IT says "localhost". Every port used to, including the ones the row went on to
 * explain had never reached it, which is the one thing a reader must not skim past. */
const PORT_CHIP: Record<MachinePortRow[`state`], string> = {
    mirrored: `bg-success/10 text-success`,
    "held-by-sandbox": `bg-warning/10 text-warning`,
    busy: `bg-subtle/10 text-subtle`,
};
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <!-- The watcher first: it decides whether everything below it is still true. A healthy folder list under
             a dead watcher means new ports stop appearing and commits stop arriving, with every other row here
             reading exactly as it did the moment before. -->
        <div v-if="watcher" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
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

        <!-- A wash mixed from the ink rather than a surface token, because this body is framed twice: the web app
             hangs it inside a card and the desktop app inside a canvas section, and any named surface is
             invisible against one of them. 3% of content reads as a panel over either ground, in either scheme —
             the same recipe the fleet board's lanes use. -->
        <div v-for="group in groups" :key="group.sandboxId" class="flex flex-col gap-2 rounded-lg border border-line bg-content/3 px-3 py-2.5">
            <!-- WHOSE FOLDER AND PORTS THESE ARE, said once at the top of the block instead of on every row
                 inside it. Quiet on purpose: it is the block's address, and the reader is here for its contents. -->
            <div class="flex min-w-0 items-center gap-1.5">
                <Icon name="box" class="shrink-0 text-2xs text-subtle" />
                <span class="truncate font-mono text-2xs text-muted">{{ group.sandboxId }}</span>
            </div>

            <!-- The label column is what the old rows never had: two facts of different kinds, each starting at
                 the same x, so a folder and a stack of ports read as one block rather than five loose lines. -->
            <div class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2">
                <template v-if="group.folder">
                    <span class="text-2xs text-subtle">Folder</span>
                    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <!-- The answer to the question this whole view was built for: WHICH folder on that
                             computer is this sandbox's /work. The daemon never learns it (SYNC_DIR is the
                             agent's own state), so before the machine report there was nowhere in the product it
                             could be read — which is why it is the one line here set at reading size, and why it
                             is copyable: the reason to look it up is almost always to go there. -->
                        <!-- WRAPS RATHER THAN TRUNCATES. The end of a path is the part that identifies it, and
                             an ellipsis eats exactly that — on a narrow window every row read
                             "/home/radarsu/intentic/radarsu-web…", which is the same sentence for every sandbox
                             on the machine. Two lines of a path a reader can finish beats one line they cannot. -->
                        <span v-if="group.folder.localDir" class="break-all font-mono text-xs text-content">{{ group.folder.localDir }}</span>
                        <span v-else-if="group.folder.mode === `mirror`" class="text-xs text-subtle">
                            no folder — this computer only mirrors ports
                        </span>
                        <span v-else class="text-xs text-subtle">no folder synced</span>
                        <CopyButton v-if="group.folder.localDir" :text="group.folder.localDir" v-tooltip.top="`Copy path`" />
                        <StatusBadge
                            v-if="folderState(group.folder)"
                            :variant="folderTone(folderState(group.folder))"
                            size="xs"
                            :label="folderState(group.folder) ?? ``"
                        />
                        <!-- Two-way-safe flags conflicts instead of clobbering, and nothing else in the product
                             has ever said one was waiting — so a file edited on both ends sat stuck with no way
                             to find out. -->
                        <StatusBadge
                            v-if="group.folder.conflicts"
                            variant="warning"
                            size="xs"
                            :label="`${group.folder.conflicts} ${group.folder.conflicts === 1 ? `conflict` : `conflicts`}`"
                        />
                    </div>
                </template>

                <template v-if="group.ports.length > 0">
                    <span class="text-2xs text-subtle">Ports</span>
                    <div class="flex min-w-0 flex-col gap-1">
                        <div v-for="port in group.ports" :key="`${port.port}:${port.state}`" class="flex min-w-0 items-baseline gap-2">
                            <span class="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-2xs font-medium" :class="PORT_CHIP[port.state]">
                                {{ port.state === `mirrored` ? `localhost:${port.port}` : port.port }}
                            </span>
                            <!-- Why it is not on localhost, and what wanted it — side by side while there is
                                 room, and the program dropping onto its own line when there is not, rather than
                                 being squeezed to "· do…" next to a sentence that has wrapped three times. -->
                            <div class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                                <span v-if="portNote(port)" class="min-w-0 text-2xs text-muted">{{ portNote(port) }}</span>
                                <!-- What is listening on the sandbox side, named rather than quoted — the whole
                                     command line is on the hover, where its width costs the row nothing. The dot
                                     is only drawn after a sentence: a program name butted against "…already has
                                     it" reads as the end of that sentence rather than as the next fact. -->
                                <span
                                    v-if="shortCommand(port.command)"
                                    class="max-w-full shrink-0 truncate font-mono text-2xs text-subtle"
                                    :title="port.command"
                                >
                                    <span v-if="portNote(port)" aria-hidden="true">· </span>{{ shortCommand(port.command) }}
                                </span>
                            </div>
                        </div>
                    </div>
                </template>
            </div>
        </div>

        <p v-if="groups.length === 0" class="text-2xs text-muted">This computer isn't syncing a folder or holding any ports for this sandbox.</p>
    </div>
</template>
