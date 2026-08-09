<!-- WHAT ONE COMPUTER IS DOING FOR A SANDBOX — the folders it syncs, the ports it put on localhost, the
     containers it runs, and whether the watcher behind the first two is alive.

     This is the BODY only, deliberately. The desktop app frames it as a section of its manager window and the web
     app frames it as an expanded row on the Computers tab; the chrome differs, and every fact inside it does not.
     Before this existed the same facts had exactly one rendering — `intentic-sync status`, on a terminal that the
     desktop app's whole premise is not needing.

     ONE ROW PER SANDBOX, which is the redesign. The report's own shape — a flat list of folders and a flat list
     of ports, each row carrying the sandbox it belongs to — was rendered straight through, so a machine serving
     two sandboxes drew six rows that each repeated a thirty-character id beside the path or the port the reader
     actually came for, at the same size and nearly the same grey.

     THE CONTAINER JOINS THAT ROW rather than getting a list of its own, which is the second half of the same
     idea. A machine's sandboxes were printed twice on the Computers tab — once as folders and ports under one
     heading, once as containers with buttons under another — under two different names for the same box, with
     nothing on screen relating them. One sandbox, one row, in reading order: what it is, where its files are,
     what you can open, what you can do to it.

     NO BOX INSIDE THE BOX. Each block used to be a filled, bordered card sitting inside the caller's own card,
     two deep, which is what made a page of small facts feel like a page of containers. Rows are separated by a
     hairline and aligned to one label column instead — alignment is what makes a list scannable, not an outline
     around every item in it.

     Derivations live in machineDetail.ts, including the prop shapes: they are STRUCTURAL rather than the sandbox
     contract's own types (`@intentic/ui` carries no domain dependency) and a MachineReport satisfies them. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from "vue";
import CopyButton from "./CopyButton.vue";
import {
    folderState,
    folderTone,
    type MachineFolderRow,
    type MachinePortRow,
    type MachineSandboxGroup,
    type MachineSandboxRow,
    type MachineWatcherState,
    portHolder,
    portNote,
    sandboxGroups,
    shortCommand,
} from "./machineDetail.js";
import StatusBadge from "./StatusBadge.vue";

const {
    pairings = [],
    ports = [],
    sandboxes = [],
    watcher,
} = defineProps<{
    pairings?: MachineFolderRow[];
    ports?: MachinePortRow[];
    /* The containers on the machine, when the caller knows them — only one does, because the daemon fills them
     * by reading docker and a sandbox cannot look for itself. Absent, every row below is a folder and its ports,
     * which is exactly what this component drew before a container was ever passed to it. */
    sandboxes?: MachineSandboxRow[];
    watcher?: MachineWatcherState | undefined;
}>();

defineSlots<{
    /** What the caller calls this list, set on the same line as the watcher's own state. */
    heading?: () => unknown;
    /** Anything else worth saying about one sandbox, beside its name. */
    badges?: (props: { group: MachineSandboxGroup }) => unknown;
    /** What can be DONE to it, right-aligned on the same line. The caller owns the verbs. */
    actions?: (props: { group: MachineSandboxGroup }) => unknown;
    /** What follows the row while it is working — a run log, the result of the last action. */
    footer?: (props: { group: MachineSandboxGroup }) => unknown;
}>();

const groups = computed(() => sandboxGroups(pairings, ports, sandboxes));

/* A PORT IS AN ADDRESS, NOT A STATUS, so it wears a chip of its own rather than a StatusBadge: monospaced, so
 * numbers line up down the column and 8788 cannot be misread as 8788o, and square, because the pill shape is
 * this app's word for a state. The tint is the outcome — green is a port you can open right now, and on a card
 * where nothing else is green any more, that is a thing the eye finds rather than one more coloured pill.
 *
 * And only a port that MADE IT says "localhost". Every port used to, including the ones the row went on to
 * explain had never reached it, which is the one thing a reader must not skim past. */
const PORT_CHIP: Record<MachinePortRow[`state`], string> = {
    mirrored: `bg-success/10 text-success`,
    "held-by-sandbox": `bg-warning/10 text-warning`,
    busy: `bg-subtle/10 text-subtle`,
};

// The ports split by outcome, because they are read differently: the ones that worked are a row of addresses to
// scan, and each one that did not needs a sentence naming what to do about it.
const reachable = (group: MachineSandboxGroup): MachinePortRow[] => group.ports.filter((port) => port.state === `mirrored`);
const blocked = (group: MachineSandboxGroup): MachinePortRow[] => group.ports.filter((port) => port.state !== `mirrored`);

/* A HEALTHY SYNC SAYS NOTHING IN COLOUR. Mutagen's resting word is "watching", and it was drawn as a green pill
 * beside the path on every row of every healthy machine — next to a green watcher badge, green port chips and a
 * green liveness badge, which is four greens for four different things and therefore no signal at all. The word
 * stays (it is the session's own state, and this view exists to replace the CLI that prints it); only the states
 * worth looking at keep the pill. */
const restingSync = (folder: MachineFolderRow): boolean => folderTone(folderState(folder)) === `success`;

/* GOING TO WHOEVER TOOK THE PORT.
 *
 * The note names the sandbox that won; the row that names it again is somewhere above or below on this same
 * card, and it is the row with the Stop button on it — so the note has a destination and, until now, no way to
 * say so. This scrolls to that block and flashes it, which is the whole gesture: a card can hold four sandboxes
 * and the eye has no idea which line to look for.
 *
 * Scoped by `uid` rather than by sandbox id alone because a page renders one of these per COMPUTER, and two
 * machines pairing the same sandbox would otherwise both answer to the same element id — the first in the
 * document wins, and the reader is scrolled to a different computer's copy of the row.
 *
 * The flash is a class the block wears for a beat, not a permanent selection: nothing was chosen, and a row left
 * highlighted reads as state the reader now has to clear. */
// Long enough to find the row after the scroll settles, short enough that it is over before it is furniture.
const FLASH_MS = 1600;

const uid = useId();
const blockId = (group: MachineSandboxGroup): string => `${uid}-${group.sandboxId}`;
const flashing = ref<string>();
let flashTimer: ReturnType<typeof setTimeout> | undefined;

const showHolder = (holder: MachineSandboxGroup): void => {
    const id = blockId(holder);
    document.getElementById(id)?.scrollIntoView({ behavior: `smooth`, block: `center` });
    clearTimeout(flashTimer);
    flashing.value = id;
    flashTimer = setTimeout(() => (flashing.value = undefined), FLASH_MS);
};
onBeforeUnmount(() => clearTimeout(flashTimer));
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- The watcher first: it decides whether everything below it is still true. A healthy folder list under
             a dead watcher means new ports stop appearing and commits stop arriving, with every other row here
             reading exactly as it did the moment before. Running is the resting state and reads as one quiet
             line; stopped is the one that has to be seen, and keeps the badge. -->
        <div v-if="watcher || $slots[`heading`]" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <slot name="heading" />
            <div v-if="watcher" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <template v-if="watcher.running">
                    <span class="inline-flex items-center gap-1.5 text-xs text-muted">
                        <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
                        Sync agent running
                    </span>
                    <span v-if="watcher.pid !== undefined" class="font-mono text-2xs text-subtle">pid {{ watcher.pid }}</span>
                </template>
                <template v-else>
                    <StatusBadge variant="warning" :dot="true" size="xs" label="Sync agent stopped" />
                    <span class="text-xs text-warning">
                        Nothing is reaching this computer's folders or ports until it restarts —
                        <span class="font-mono">intentic-sync mirror</span>
                    </span>
                </template>
            </div>
        </div>

        <div class="flex flex-col">
            <div
                v-for="group in groups"
                :key="group.sandboxId"
                :id="blockId(group)"
                class="flex flex-col gap-2 border-t border-line py-3 transition-colors duration-500 first:border-t-0 first:pt-0 last:pb-0"
                :class="flashing === blockId(group) ? `bg-warning/10` : ``"
            >
                <!-- WHICH SANDBOX THIS IS, and what can be done to it — one line, so a machine's list is read
                     down its names rather than down the boxes those names used to sit in. -->
                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                    <!-- Running is a dot and nothing else — it is the resting state of every row on a healthy
                         machine, and a word for it on all of them is a word that stops being read. The state
                         still reaches a screen reader, and stopped keeps its word below. -->
                    <span
                        v-if="group.sandbox"
                        class="h-1.5 w-1.5 shrink-0 rounded-full"
                        :class="group.sandbox.running ? `bg-success` : `bg-subtle`"
                        role="img"
                        :aria-label="group.sandbox.running ? `running` : `stopped`"
                        :title="group.sandbox.running ? `running` : `stopped`"
                    ></span>
                    <Icon v-else name="box" class="shrink-0 text-2xs text-subtle" />
                    <span class="truncate text-xs text-content" :class="group.sandbox ? `font-semibold` : `font-mono font-medium`">
                        {{ group.title }}
                    </span>
                    <!-- Running is said by the dot; stopped is said in words, because it is the state somebody
                         has to notice and a grey dot is what "nothing to see" looks like. -->
                    <span v-if="group.sandbox && !group.sandbox.running" class="text-2xs text-muted">stopped</span>
                    <!-- Absent tunnel and stopped tunnel are different facts; only the second is a warning. -->
                    <StatusBadge v-if="group.sandbox?.tunnelRunning === false" variant="warning" size="xs" label="tunnel off" />
                    <slot name="badges" :group="group" />
                    <span v-if="$slots[`actions`]" class="ml-auto flex shrink-0 items-center gap-0.5"><slot name="actions" :group="group" /></span>
                </div>

                <!-- The label column is what the old rows never had: facts of three kinds, each starting at the
                     same x, so a folder, a stack of ports and an image read as one block rather than as loose
                     lines that happen to sit near each other. -->
                <div class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5">
                    <template v-if="group.folder">
                        <span class="text-2xs text-subtle">Folder</span>
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <!-- The answer to the question this whole view was built for: WHICH folder on that
                                 computer is this sandbox's /work. The daemon never learns it (SYNC_DIR is the
                                 agent's own state), so before the machine report there was nowhere in the product
                                 it could be read — which is why it is copyable: the reason to look it up is
                                 almost always to go there. -->
                            <!-- WRAPS RATHER THAN TRUNCATES. The end of a path is the part that identifies it, and
                                 an ellipsis eats exactly that — on a narrow window every row read
                                 "/home/radarsu/intentic/radarsu-web…", which is the same sentence for every
                                 sandbox on the machine. Two lines of a path a reader can finish beats one line
                                 they cannot. -->
                            <span v-if="group.folder.localDir" class="break-all font-mono text-xs text-content">{{ group.folder.localDir }}</span>
                            <span v-else-if="group.folder.mode === `mirror`" class="text-xs text-subtle">
                                no folder — this computer only mirrors ports
                            </span>
                            <span v-else class="text-xs text-subtle">no folder synced</span>
                            <CopyButton v-if="group.folder.localDir" :text="group.folder.localDir" v-tooltip.top="`Copy path`" />
                            <span v-if="folderState(group.folder) && restingSync(group.folder)" class="text-2xs text-subtle">
                                {{ folderState(group.folder) }}
                            </span>
                            <StatusBadge
                                v-else-if="folderState(group.folder)"
                                :variant="folderTone(folderState(group.folder))"
                                size="xs"
                                :label="folderState(group.folder) ?? ``"
                            />
                            <!-- Two-way-safe flags conflicts instead of clobbering, and nothing else in the
                                 product has ever said one was waiting — so a file edited on both ends sat stuck
                                 with no way to find out. -->
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
                        <div class="flex min-w-0 flex-col gap-1.5">
                            <!-- THE ONES YOU CAN OPEN, as one wrapping row. Each is three words long and there
                                 are often five of them, so a line apiece turned the answer to "which port did I
                                 get" into a column to read top to bottom. -->
                            <div v-if="reachable(group).length > 0" class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                                <span v-for="port in reachable(group)" :key="`${port.port}:${port.state}`" class="flex min-w-0 items-baseline gap-1.5">
                                    <span class="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs font-medium" :class="PORT_CHIP[port.state]">
                                        localhost:{{ port.port }}
                                    </span>
                                    <!-- What is listening on the sandbox side, named rather than quoted — the
                                         whole command line is on the hover, where its width costs nothing. -->
                                    <span v-if="shortCommand(port.command)" class="truncate font-mono text-2xs text-subtle" :title="port.command">
                                        {{ shortCommand(port.command) }}
                                    </span>
                                </span>
                            </div>
                            <!-- AND THE ONES THAT DID NOT MAKE IT, one per line: each is a different sentence
                                 about a different thing to go and do. -->
                            <!-- The number stays put and the sentence wraps BESIDE it rather than under it: a
                                 narrow column otherwise left the port alone on a line of its own, which is the
                                 one thing on the row that never needed a line to itself. -->
                            <div v-for="port in blocked(group)" :key="`${port.port}:${port.state}`" class="flex min-w-0 items-baseline gap-2">
                                <span class="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs font-medium" :class="PORT_CHIP[port.state]">
                                    {{ port.port }}
                                </span>
                                <p class="min-w-0 flex-1 text-xs text-muted">
                                    {{ portNote(port, portHolder(groups, port)) }}
                                    <!-- What is listening on the sandbox side, named rather than quoted — the
                                         whole command line is on the hover, where its width costs nothing. -->
                                    <span v-if="shortCommand(port.command)" class="font-mono text-2xs text-subtle" :title="port.command">
                                        · {{ shortCommand(port.command) }}
                                    </span>
                                    <!-- THE ONE THING THERE IS TO DO ABOUT IT. The sentence has always named the
                                         winner and stopped there, which left a reader who wanted their port back
                                         with a name and no idea it was a row on this very card — so the note
                                         ended as a fact about the past. This is the link between the two: it goes
                                         to the holder's block, where its Stop button is, and stopping it hands
                                         the number back on the next sync tick.

                                         Inline and underlined rather than a button, because it belongs to the
                                         sentence: a button here would sit in the column of verbs that act on THIS
                                         sandbox and read as one of them. Absent when the holder is not on this
                                         report — there is nothing to scroll to, and a dead link is worse than the
                                         sentence alone. -->
                                    <button
                                        v-if="portHolder(groups, port)"
                                        type="button"
                                        class="ml-1 rounded underline decoration-dotted underline-offset-2 transition-colors hover:text-content"
                                        @click="showHolder(portHolder(groups, port)!)"
                                    >
                                        show it
                                    </button>
                                </p>
                            </div>
                        </div>
                    </template>

                    <!-- WHICH IMAGE it is on — the fact an Update is about, and the only way to see that one
                         sandbox on this machine runs something older than its neighbour. Last, and in the
                         quietest ink on the row: it is the longest string here and the least often read. -->
                    <template v-if="group.sandbox">
                        <span class="text-2xs text-subtle">Image</span>
                        <span class="truncate font-mono text-2xs text-subtle" :title="group.sandbox.image">{{ group.sandbox.image }}</span>
                    </template>
                </div>

                <slot name="footer" :group="group" />
            </div>
        </div>

        <p v-if="groups.length === 0" class="text-xs text-muted">This computer isn't syncing a folder or holding any ports for this sandbox.</p>
    </div>
</template>
