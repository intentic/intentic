<!-- WHAT ONE DEVICE IS DOING FOR A SANDBOX: the folders it syncs, the ports it put on localhost, the
     containers it runs, and whether the agent behind the first two is alive.

     This is the BODY only, deliberately. The desktop app frames it as a section of its manager window and the web
     app frames it as an expanded row on the Devices tab; the chrome differs, and every fact inside it does not.
     Before this existed the same facts had exactly one rendering: the agent's printed status, on a terminal that the
     desktop app's whole premise is not needing.

     ONE ROW PER SANDBOX, which is the redesign. The report's own shape: a flat list of folders and a flat list
     of ports, each row carrying the sandbox it belongs to: was rendered straight through, so a machine serving
     two sandboxes drew six rows that each repeated a thirty-character id beside the path or the port the reader
     actually came for, at the same size and nearly the same grey.

     THE CONTAINER JOINS THAT ROW rather than getting a list of its own, which is the second half of the same
     idea. A machine's sandboxes were printed twice on the Devices tab: once as folders and ports under one
     heading, once as containers with buttons under another: under two different names for the same box, with
     nothing on screen relating them. One sandbox, one row, in reading order: what it is, where its files are,
     what you can open, what you can do to it.

     NO BOX INSIDE THE BOX. Each block used to be a filled, bordered card sitting inside the caller's own card,
     two deep, which is what made a page of small facts feel like a page of containers. Rows are separated by a
     hairline and aligned to one label column instead: alignment is what makes a list scannable, not an outline
     around every item in it.

     Derivations live in deviceDetail.ts, including the prop shapes: they are STRUCTURAL rather than the sandbox
     contract's own types (`@intentic/ui` carries no domain dependency) and a DeviceReport satisfies them. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import CopyButton from "./CopyButton.vue";
import Icon from "./Icon.vue";
import {
    backupState,
    backupTone,
    folderState,
    folderTone,
    groupNeedsAttention,
    groupSummary,
    type DeviceFolderRow,
    type DevicePortRow,
    type DeviceSandboxGroup,
    type DeviceSandboxRow,
    type DeviceAgentState,
    mirroringOff,
    portHolder,
    portNote,
    sandboxGroups,
    shortCommand,
} from "./deviceDetail.js";
import StatusBadge from "./StatusBadge.vue";

const {
    pairings = [],
    ports = [],
    sandboxes = [],
    agent,
    open = [],
    undivided = false,
} = defineProps<{
    pairings?: readonly DeviceFolderRow[];
    ports?: readonly DevicePortRow[];
    /* The containers on the machine, when the caller knows them: the desktop app from its own `docker ps`, the
     * daemon from a `host`-capability one. Absent, every row below is a folder and its ports, which is exactly
     * what this component drew before a container was ever passed to it. */
    sandboxes?: readonly DeviceSandboxRow[];
    /* THE DEVICE'S AGENT, for a caller with nowhere else to put it. The web app's Devices tab has a device row
     * above this list and states it there, in a block with its update and restart buttons, so it passes none:
     * this used to draw "Agent running · pid …" as the right-hand half of a heading over a list of
     * CONTAINERS, one tier below the row whose own badge already said the same thing. The desktop app's window
     * has no such row over it and does pass it. */
    agent?: DeviceAgentState | undefined;
    /* Sandbox ids the CALLER wants unfolded on arrival: the sandbox this page is being read from, a row a
     * search just matched. Everything the component can work out for itself (a port that never reached
     * localhost, a file conflict, a dead tunnel) it unfolds without being told; this is for the facts it cannot
     * know. Reactive: a filter that narrows to one row opens it as it lands. */
    open?: readonly string[];
    /* `undivided` DROPS THE HAIRLINES BETWEEN SANDBOXES, for a caller that is itself a list.
     *
     * ONE SEPARATOR PER TIER, or the tiers stop being readable. The desktop app frames this as the one list on
     * a window about one device, so its hairlines are the strongest line on screen and mean exactly what they
     * look like. The Devices tab nests it under a MACHINE, whose own rows are parted by the card's hairline
     * (RowGroup) at the same width and the same token: two tiers drawn with one stroke, so the line ending
     * `radarsu-rog` and the line between two of its sandboxes were the same mark, and a reader scrolling had
     * nothing to tell them apart with but a 44px inset.
     *
     * Set there, the hairline is left to mean "the next DEVICE" and nothing else, and the rhythm of the rows
     * parts the sandboxes under one, the way whitespace parts the providers on the Plan limits panel. */
    undivided?: boolean;
}>();

defineSlots<{
    /** What the caller calls this list, set on the same line as the agent's own state, when the caller passes one. */
    heading?: () => unknown;
    /** Anything else worth saying about one sandbox, beside its name. */
    badges?: (props: { group: DeviceSandboxGroup }) => unknown;
    /** What can be DONE to it, right-aligned on the same line. The caller owns the verbs. */
    actions?: (props: { group: DeviceSandboxGroup }) => unknown;
    /* What can be done about this row's FILE SYNC, under the folder it is about: the twin of `ports` below, and
     * for the same reason. Pausing a sync and stopping a container are different enough acts that they must not
     * share a cluster of buttons; each belongs under the line that describes what it changes.
     *
     * It exists because the two halves of one pairing had grown two different affordances: the ports line got a
     * button, and the folder line got a paragraph naming a command to go and type in a terminal, on the very
     * view built to replace that terminal. The caller owns it, because this package knows what a file sync IS
     * and nothing about the door to the machine that pauses one. */
    folder?: (props: { group: DeviceSandboxGroup }) => unknown;
    /* What can be done about this row's PORTS, at the end of the ports line rather than up in `actions`.
     *
     * Its own slot because the row's verbs are its CONTAINER's: a "Stop mirroring" sitting beside the Stop that
     * stops the sandbox is two different stops a pixel apart, and the one that only clears a localhost would be
     * read as the one that kills the box. Down here it is attached to the thing it changes, which is the same
     * argument the "show it" link in the port notes already makes.
     *
     * The caller owns it for the usual reason: this package knows what mirroring IS and nothing about the door
     * to the machine that turns it off. */
    ports?: (props: { group: DeviceSandboxGroup }) => unknown;
    /** What follows the row while it is working: a run log, the result of the last action. */
    footer?: (props: { group: DeviceSandboxGroup }) => unknown;
}>();

const groups = computed(() => sandboxGroups(pairings, ports, sandboxes));

/* WHICH ROWS ARE UNFOLDED: the change this view most needed.
 *
 * Every fact about every sandbox used to be on screen at once: a machine running four of them drew four folders,
 * four port stacks and four image lines, and three machines was a page nobody could scan. So a row is a LINE
 * until it is asked for, and the line still carries what a reader is checking (`groupSummary`).
 *
 * What opens itself is what somebody has to act on (a port that never reached localhost, a file conflict, a dead
 * tunnel) plus whatever the caller named. Deliberately not "stopped": plenty of sandboxes are stopped on
 * purpose, and unfolding every one of them hands back the wall this is folding away. */
const autoOpen = computed(() => new Set([...open, ...groups.value.filter(groupNeedsAttention).map((group) => group.sandboxId)]));

/* TWO SETS, NOT ONE, and the pair is what keeps this list still under the pointer. A single "open" set has to be
 * re-seeded from the rule on every poll, which either re-opens a row the reader just folded or freezes the rule
 * out entirely. Recording the reader's own GESTURES instead lets the rule decide only where they made none, and
 * this list re-derives itself every ten seconds, so anything less is a page that moves while it is read. */
const opened = ref(new Set<string>());
const folded = ref(new Set<string>());
const isOpen = (group: DeviceSandboxGroup): boolean =>
    opened.value.has(group.sandboxId) || (autoOpen.value.has(group.sandboxId) && !folded.value.has(group.sandboxId));
const toggle = (group: DeviceSandboxGroup): void => {
    const id = group.sandboxId;
    const shutting = isOpen(group);
    opened.value = new Set([...opened.value].filter((seen) => seen !== id));
    folded.value = new Set([...folded.value].filter((seen) => seen !== id));
    const target = shutting ? folded : opened;
    target.value = new Set([...target.value, id]);
};
/* A row the caller newly named (a search hit) must OPEN, not flip. Without this, a row the reader had folded
 * by hand stays folded when the filter narrows to it alone, which reads as a filter that found nothing. */
watch(
    () => [...open].join(`|`),
    () => (folded.value = new Set([...folded.value].filter((id) => !open.includes(id)))),
);

/* A PORT IS AN ADDRESS, NOT A STATUS, which is why it no longer wears a chip.
 *
 * Each one used to be a tinted, rounded pill: green for reachable, amber for contested, grey for busy. On a
 * sandbox serving three ports that is three filled shapes in a four-line block that also holds a path, a
 * program name, a sentence and an image, and the green was on the RESTING state, so a healthy card was mostly
 * green and green had stopped carrying a signal. Ink says it instead, and the block has no backgrounds left.
 *
 * Only a port that MADE IT says "localhost". Every port used to, including the ones the row went on to explain
 * had never reached it, which is the one thing a reader must not skim past. `group.ports` is already sorted
 * outcome-first (deviceDetail.ts), so the ones you can open lead the list without a second pass over it.
 *
 * `held-by-sandbox` and `busy` differ in their SENTENCE, not their treatment: both are a number that is not on
 * localhost, and what to do about each is what the note says. */

/* A HEALTHY SYNC SAYS NOTHING IN COLOUR. Mutagen's resting word is "watching", and it was drawn as a green pill
 * beside the path on every row of every healthy machine: next to a green agent badge, green port chips and a
 * green liveness badge, which is four greens for four different things and therefore no signal at all. The word
 * stays (it is the session's own state, and this view exists to replace the CLI that prints it); only the states
 * worth looking at keep the pill. */
const restingSync = (folder: DeviceFolderRow): boolean => folderTone(folderState(folder)) === `success`;

/* And the same rule for the state BACKUP, which is a second session with a second word and no reason to be
 * louder about being fine. Its first draft printed "backup on" beside every healthy row, on the argument that
 * an absent backup is invisible until the day it matters, but that argues for the FAILING case being loud,
 * which it is, not for the resting one being present. A grey word next to a grey path, saying what the machine's
 * own "agent running" line already says, is exactly the noise the rule above deletes. */
const restingBackup = (folder: DeviceFolderRow): boolean => backupTone(backupState(folder)) === `success`;

/* GOING TO WHOEVER TOOK THE PORT.
 *
 * The note names the sandbox that won; the row that names it again is somewhere above or below on this same
 * card, and it is the row with the Stop button on it, so the note has a destination and, until now, no way to
 * say so. This scrolls to that block and flashes it, which is the whole gesture: a card can hold four sandboxes
 * and the eye has no idea which line to look for.
 *
 * Scoped by `uid` rather than by sandbox id alone because a page renders one of these per DEVICE, and two
 * machines pairing the same sandbox would otherwise both answer to the same element id: the first in the
 * document wins, and the reader is scrolled to a different device's copy of the row.
 *
 * The flash is a class the block wears for a beat, not a permanent selection: nothing was chosen, and a row left
 * highlighted reads as state the reader now has to clear. */
// Long enough to find the row after the scroll settles, short enough that it is over before it is furniture.
const FLASH_MS = 1600;

const uid = useId();
const blockId = (group: DeviceSandboxGroup): string => `${uid}-${group.sandboxId}`;
const flashing = ref<string>();
let flashTimer: ReturnType<typeof setTimeout> | undefined;

const showHolder = (holder: DeviceSandboxGroup): void => {
    const id = blockId(holder);
    // Opened before it is jumped to: the holder's row is folded like every other, and scrolling somebody to a
    // closed line is the same dead end the note had before it became a link.
    if (!isOpen(holder)) {
        toggle(holder);
    }
    document.getElementById(id)?.scrollIntoView({ behavior: `smooth`, block: `center` });
    clearTimeout(flashTimer);
    flashing.value = id;
    flashTimer = setTimeout(() => (flashing.value = undefined), FLASH_MS);
};
onBeforeUnmount(() => clearTimeout(flashTimer));
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- The agent first, where a caller passes one: it decides whether everything below it is still true. A healthy folder list under
             a dead loop means new ports stop appearing and commits stop arriving, with every other row here
             reading exactly as it did the moment before. Running is the resting state and reads as one quiet
             line; stopped is the one that has to be seen, and keeps the badge. -->
        <div v-if="agent || $slots[`heading`]" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <slot name="heading" />
            <div v-if="agent" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <!-- Alive but not working: the process is up and its loop is not, so the rows below are a
                     photograph of whenever it last ran. Amber like "stopped", because the errand is the same one
                     and the difference (that a restart is needed even though nothing looks dead) is exactly
                     what a reader cannot infer from a green line. -->
                <template v-if="agent.stalled === true">
                    <StatusBadge variant="warning" :dot="true" size="xs" label="agent stalled" />
                    <span class="text-xs text-warning">
                        Its process is alive but has stopped making rounds, so ports and commits below may be out of date. Restart it with
                        <span class="font-mono">intentic-machine run --stop</span> then <span class="font-mono">intentic-machine run</span>
                    </span>
                </template>
                <template v-else-if="agent.running">
                    <span class="inline-flex items-center gap-1.5 text-xs text-muted">
                        <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
                        Agent running
                    </span>
                    <span v-if="agent.pid !== undefined" class="font-mono text-2xs text-subtle">pid {{ agent.pid }}</span>
                    <!-- Working, and working from an agent this machine has already replaced. Not a badge: nothing
                         is broken, every row below is true, and the only thing owed is a restart. But it is said
                         on the same line as the version people read off this block, because "I updated the agent
                         and the number never moved" is where this ends up otherwise. -->
                    <span v-if="agent.staleBuild !== undefined" class="text-xs text-warning">
                        <template v-if="agent.staleBuild.running">
                            on <span class="font-mono">{{ agent.staleBuild.running }}</span>, while
                            <span class="font-mono">{{ agent.staleBuild.installed }}</span> is installed here
                        </template>
                        <!-- The loop is too old to say which build it is, which is not a gap in the answer: it
                             is the answer, and the furthest-behind a machine gets. -->
                        <template v-else>
                            on a build older than the <span class="font-mono">{{ agent.staleBuild.installed }}</span> installed here
                        </template>
                        <!-- The two commands stay whole across a wrap. This sentence is long enough to break
                             on any real width, and it broke mid-command ("intentic-" / "machine run"), which is
                             the one part of it a reader has to retype. -->
                        — it keeps the build it started with, so restart it with
                        <span class="font-mono whitespace-nowrap">intentic-machine run --stop</span> then
                        <span class="font-mono whitespace-nowrap">intentic-machine run</span>
                    </span>
                </template>
                <template v-else>
                    <StatusBadge variant="warning" :dot="true" size="xs" label="agent stopped" />
                    <span class="text-xs text-warning">
                        Nothing is reaching this device's folders or ports until it restarts:
                        <span class="font-mono">intentic-machine run</span>
                    </span>
                </template>
            </div>
        </div>

        <div class="flex flex-col">
            <div
                v-for="group in groups"
                :key="group.sandboxId"
                :id="blockId(group)"
                class="flex flex-col gap-2 transition-colors duration-500"
                :class="[
                    undivided ? `pb-3 last:pb-0` : `border-t border-line-subtle py-2 first:border-t-0 first:pt-0 last:pb-0`,
                    flashing === blockId(group) ? `bg-warning/10` : ``,
                ]"
            >
                <!-- WHICH SANDBOX THIS IS, WHETHER IT IS FINE, and what can be done to it: all on the one line
                     that is the whole row until somebody asks for more.
                     The chevron and the name are ONE button. A disclosure whose only hit area is a 12px glyph is
                     a disclosure nobody finds; the verbs keep their own hit areas outside it, so opening a row
                     and acting on one are never the same click.

                     NOT A <DisclosureRow>, AND ON PURPOSE — but the reason is the TIER, not the spelling.
                     Fourteen expandable rows across the app moved onto that component, the Devices tab's
                     machine rows among them. These did not, because a block here is a REPORT ENTRY INSIDE one
                     of those rows rather than an entry in a list: it is set at `py-0.5` against the
                     component's tightest tier, and the surface under it is already an open row's.

                     WHICH IS ALSO WHY IT TAKES NO OPEN WASH, and that is the one question this file gets
                     asked. Every list in the hub lights an opened row `bg-content/6`, and the tier ABOVE this
                     one does too, so an open sandbox here is already sitting on that wash — a second one
                     inside it is a tint on a tint, and by the time a reader has a machine and two of its
                     sandboxes unfolded, most of the card is washed and the wash has stopped meaning "open".
                     These rows also unfold THEMSELVES (a contested port, a dead tunnel, the sandbox you are
                     reading this in), so the state a wash would mark is the one they arrive in. What says a
                     row is open is what a report can afford: the chevron's angle, the block indented to its
                     column, and the folded line's summary giving way to the facts in full.

                     What this DOES take from <DisclosureRow> is the spelling: `chevron-right` + `rotate-90`
                     at `text-2xs text-subtle`, `aria-expanded` + `aria-controls`, the chevron and the row's
                     own mark as ONE hit area, and the opened block indented to the chevron's own column.
                     Change those here only by changing them there first. -->
                <div class="flex min-w-0 items-center gap-x-2">
                    <button
                        type="button"
                        class="group/row flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-0.5 text-left"
                        :aria-expanded="isOpen(group)"
                        :aria-controls="`${blockId(group)}-detail`"
                        @click="toggle(group)"
                    >
                        <Icon
                            name="chevron-right"
                            class="shrink-0 text-2xs text-subtle transition-transform group-hover/row:text-muted"
                            :class="isOpen(group) ? `rotate-90` : undefined"
                            aria-hidden="true"
                        />
                        <!-- Running is a dot and nothing else: it is the resting state of every row on a healthy
                             machine, and a word for it on all of them is a word that stops being read. The state
                             still reaches a screen reader, and stopped keeps its word beside it. -->
                        <span
                            v-if="group.sandbox"
                            class="h-1.5 w-1.5 shrink-0 rounded-full"
                            :class="group.sandbox.running ? `bg-success` : `bg-subtle`"
                            role="img"
                            :aria-label="group.sandbox.running ? `running` : `stopped`"
                            :title="group.sandbox.running ? `running` : `stopped`"
                        ></span>
                        <Icon v-else name="box" class="shrink-0 text-2xs text-subtle" />
                        <span class="min-w-0 truncate text-xs font-semibold text-content">{{ group.title }}</span>
                        <!-- THE EXACT ID, kept and demoted. The title is now the most human name this sandbox
                             has (deviceDetail.ts), and this is the string somebody types into a terminal: a
                             view that showed only the friendly one would make it unfindable. -->
                        <span v-if="group.subtitle" class="hidden shrink-0 truncate font-mono text-2xs text-subtle sm:inline">
                            {{ group.subtitle }}
                        </span>
                        <!-- Running is said by the dot; stopped is said in words, because it is the state
                             somebody has to notice and a grey dot is what "nothing to see" looks like. -->
                        <span v-if="group.sandbox && !group.sandbox.running" class="shrink-0 text-2xs text-muted">stopped</span>
                        <!-- A PAIRING WITH NO CONTAINER. It rendered as a row with a different glyph, no state
                             and no verbs, and nothing said why, so it read as a sandbox the view had failed to
                             finish drawing. -->
                        <span v-else-if="!group.sandbox" class="shrink-0 text-2xs text-muted">not running here</span>
                        <slot name="badges" :group="group" />
                        <!-- WHAT THE CLOSED LINE STILL ANSWERS. Facts are counted and uncoloured; a warning is
                             the reason this row unfolded itself, in the ink that says so. Hidden while the row
                             is open, where every one of them is stated in full a few pixels below. -->
                        <span v-if="!isOpen(group)" class="ml-auto flex min-w-0 shrink items-center gap-x-2 pl-2">
                            <span v-for="fact in groupSummary(group).facts" :key="fact" class="shrink-0 text-2xs text-subtle">{{ fact }}</span>
                            <span v-for="warning in groupSummary(group).warnings" :key="warning" class="truncate text-2xs text-warning">
                                {{ warning }}
                            </span>
                        </span>
                    </button>
                    <span v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-0.5"><slot name="actions" :group="group" /></span>
                </div>

                <!-- The label column is what the old rows never had: facts of three kinds, each starting at the
                     same x, so a folder, a stack of ports and an image read as one block rather than as loose
                     lines that happen to sit near each other.
                     Indented to the chevron's own column, so an open row reads as belonging to the line above
                     it rather than as the next thing in the list. -->
                <div
                    v-if="isOpen(group)"
                    :id="`${blockId(group)}-detail`"
                    class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 pl-5"
                >
                    <template v-if="group.folder">
                        <span class="text-2xs text-subtle">Folder</span>
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <!-- The answer to the question this whole view was built for: WHICH folder on that
                                 device is this sandbox's /work. The daemon never learns it (SYNC_DIR is the
                                 agent's own state), so before the machine report there was nowhere in the product
                                 it could be read, which is why it is copyable: the reason to look it up is
                                 almost always to go there. -->
                            <!-- WRAPS RATHER THAN TRUNCATES. The end of a path is the part that identifies it, and
                                 an ellipsis eats exactly that: on a narrow window every row read
                                 "/home/radarsu/intentic/radarsu-web…", which is the same sentence for every
                                 sandbox on the machine. Two lines of a path a reader can finish beats one line
                                 they cannot. -->
                            <span v-if="group.folder.localDir" class="break-all font-mono text-xs text-content">{{ group.folder.localDir }}</span>
                            <span v-else-if="group.folder.mode === `mirror`" class="text-xs text-subtle">
                                no folder: this device only mirrors ports
                            </span>
                            <span v-else class="text-xs text-subtle">no folder synced</span>
                            <CopyButton v-if="group.folder.localDir" :text="group.folder.localDir" v-tooltip.top="`Copy path`" />
                            <!-- A HEALTHY SYNC SAYS NOTHING AT ALL NOW. Mutagen's resting word is "watching", and
                                 it was printed beside every path on every healthy machine: one more small grey
                                 word in a block already full of them, saying what the machine's own "agent
                                 running" line says once for all of them. Only the states worth looking at speak. -->
                            <StatusBadge
                                v-if="folderState(group.folder) && !restingSync(group.folder)"
                                :variant="folderTone(folderState(group.folder))"
                                size="xs"
                                :label="folderState(group.folder) ?? ``"
                            />
                            <!-- Whether anything off this sandbox holds a copy of its own state, and SILENT while
                                 the answer is yes: the same bargain the sync word above just made. The failing
                                 case is the one that matters here and it is the one that speaks: a backup that
                                 stopped costs nothing at all until the sandbox is gone, so it is named rather
                                 than left to be noticed. Labelled, because "halted-on-root-emptied" beside a
                                 folder path would otherwise read as the folder's own trouble. -->
                            <StatusBadge
                                v-if="backupState(group.folder) && !restingBackup(group.folder)"
                                :variant="backupTone(backupState(group.folder))"
                                size="xs"
                                :label="`backup: ${backupState(group.folder)}`"
                            />
                            <!-- Two-way-safe flags conflicts instead of clobbering, and nothing else in the
                                 product has ever said one was waiting, so a file edited on both ends sat stuck
                                 with no way to find out. -->
                            <StatusBadge
                                v-if="group.folder.conflicts"
                                variant="warning"
                                size="xs"
                                :label="`${group.folder.conflicts} ${group.folder.conflicts === 1 ? `conflict` : `conflicts`}`"
                            />
                        </div>
                        <!-- WHAT TO DO ABOUT THIS FOLDER, under it rather than up in the row's verbs, which act
                             on the CONTAINER. A "Pause" beside the Stop that stops the sandbox is two very
                             different pauses a pixel apart, and this one stops nothing in the sandbox at all:
                             the box keeps running, the ports keep being mirrored, the files stop moving. The
                             same argument the ports switch below already makes from its own side.
                             Spans both columns so its controls start under the path rather than in the label
                             gutter; `-ml-2.5` cancels a small text button's own padding, exactly as the ports
                             cluster does, so the words land in the block's one value column. -->
                        <span
                            v-if="$slots[`folder`]"
                            class="empty:hidden col-start-2 -ml-2.5 flex flex-wrap items-center gap-x-1 gap-y-1"
                        >
                            <slot name="folder" :group="group" />
                        </span>
                    </template>

                    <!-- The ports line survives having NO PORTS, which is the one case it used to render as
                         nothing at all. An empty list has two opposite causes, this sandbox is serving nothing,
                         or this device was told to keep its localhost clear, and the row that draws neither
                         sends whoever came asking "why is localhost empty" away with the question intact. So the
                         second one keeps the line and says so; the first is still silence, because there is
                         genuinely nothing to report and a "no ports" on every quiet row is the noise this view
                         spends its whole design deleting. -->
                    <template v-if="group.ports.length > 0 || mirroringOff(group.folder)">
                        <span class="text-2xs text-subtle">Ports</span>
                        <div class="flex min-w-0 flex-col gap-1">
                            <!-- SAID AS A STATE, NOT AS A FAULT: quiet ink, no badge, no colour. Somebody threw
                                 this switch on purpose and the row's job is to remember it out loud, which is
                                 exactly what the sandbox could not do for itself, the flag lives on the device
                                 (that is where the localhost is) and this is the only place it surfaces. -->
                            <p v-if="mirroringOff(group.folder)" class="text-xs text-muted">
                                Off: this device isn't putting this sandbox's ports on its own localhost. File syncing is unaffected.
                            </p>
                            <!-- ONE PORT PER LINE, IN TWO ALIGNED COLUMNS: the address, then what is on it or why
                             it never arrived.
                             It used to be a wrapping row of tinted chips, each trailed by a program name in a
                             smaller mono: three addresses and three programs ran together as one string, and
                             the eye had no edge to work from. Alignment is what makes a list of pairs readable,
                             which is the same argument the label column beside it already makes.
                             AND NO FILLS. Every healthy port wore a green wash, so on a card with three of them
                             plus a green running dot, green had stopped meaning anything at all: it was just
                             the colour ports are. The ink carries it now: content for one you can open, warning
                             for one you cannot, and nothing in this block has a background any more. -->
                            <!-- Suppressed while the switch is off, rather than printed under the sentence that
                                 contradicts it. The machine tears its forwards down on the same tick it reads
                                 the flag, so a row here could only ever be a reading from BEFORE that, and
                                 `localhost:5173` against a localhost that no longer has it is the one thing this
                                 block must never hand anybody (the same rule as "only a port that MADE IT says
                                 localhost", one tick further on). -->
                            <div v-else class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">
                                <template v-for="port in group.ports" :key="`${port.port}:${port.state}`">
                                    <!-- Only a port that MADE IT says "localhost". One that never reached it is a
                                     bare number, not an address nobody can open. -->
                                    <span class="shrink-0 font-mono text-xs" :class="port.state === `mirrored` ? `text-content` : `text-warning`"
                                        >{{ port.state === `mirrored` ? `localhost:` : `` }}{{ port.port }}</span
                                    >
                                    <!-- What is listening on the sandbox side, named rather than quoted: the whole
                                     command line is on the hover, where its width costs nothing. -->
                                    <span
                                        v-if="port.state === `mirrored`"
                                        class="min-w-0 truncate font-mono text-xs text-subtle"
                                        :title="port.command"
                                        >{{ shortCommand(port.command) }}</span
                                    >
                                    <span v-else class="min-w-0 text-xs text-muted">
                                        {{ portNote(port, portHolder(groups, port), shortCommand(port.command)) }}
                                        <!-- THE ONE THING THERE IS TO DO ABOUT IT. The sentence names the winner and
                                         used to stop there, which left a reader who wanted their port back with a
                                         name and no idea it was a row on this very card. This goes to the
                                         holder's block, where its Stop button is, and stopping it hands the
                                         number back on the next sync tick.

                                         Inline and underlined rather than a button, because it belongs to the
                                         sentence: a button here would sit in the column of verbs that act on THIS
                                         sandbox and read as one of them. Absent when the holder is not on this
                                         report: there is nothing to scroll to, and a dead link is worse than the
                                         sentence alone. -->
                                        <button
                                            v-if="portHolder(groups, port)"
                                            type="button"
                                            class="ml-1 rounded underline decoration-dotted underline-offset-2 transition-colors hover:text-content"
                                            @click="showHolder(portHolder(groups, port)!)"
                                        >
                                            show it
                                        </button>
                                    </span>
                                </template>
                            </div>
                            <!-- THE ONE THING TO DO ABOUT ALL OF THEM, under the list rather than beside any
                                 single line: mirroring is a per-pairing switch, not a per-port one. Empty for
                                 every caller that has no door to the machine, and `empty:hidden` keeps a caller
                                 that renders nothing from paying a gap for the privilege.

                                 `-ml-2.5` PUTS THE LABEL BACK IN THE COLUMN, and it is the whole reason this
                                 wrapper has a class at all. Every value in this block starts at one x, the path,
                                 the port numbers, the sentence, the image, because alignment is what makes a
                                 block of small facts scannable rather than a pile. A small text button carries
                                 10px of its own padding, so left-aligning its BOX indents its WORDS out of that
                                 column by exactly that much, which is visible the moment it sits under a list of
                                 monospaced addresses. The offset cancels the app's own `size="small"` text-button
                                 padding; a caller putting something else here (a plain link, an icon) should
                                 expect to want its own. -->
                            <span v-if="$slots[`ports`]" class="-ml-2.5 flex flex-wrap items-center gap-x-1 gap-y-1 empty:hidden">
                                <slot name="ports" :group="group" />
                            </span>
                        </div>
                    </template>

                    <!-- WHICH IMAGE it is on: the fact an Update is about, and the only way to see that one
                         sandbox on this machine runs something older than its neighbour. Last, and in the
                         quietest ink here: it is the longest string in the block and the least often read.
                         At the block's one value size rather than a fourth of its own: this block had six type
                         treatments in four lines, and half of them differed by a pixel nobody could name. -->
                    <template v-if="group.sandbox">
                        <span class="text-2xs text-subtle">Image</span>
                        <span class="truncate font-mono text-xs text-subtle" :title="group.sandbox.image">{{ group.sandbox.image }}</span>
                    </template>
                </div>

                <!-- The machine's own output, and whatever else the caller says about this row. Outside the
                     disclosure on purpose: a verb pressed on a folded row must show what it is doing, and a
                     reader who folds a row mid-update is not asking for the update to go quiet. -->
                <div v-if="$slots[`footer`]" class="empty:hidden pl-5"><slot name="footer" :group="group" /></div>
            </div>
        </div>

        <p v-if="groups.length === 0" class="text-xs text-muted">This device isn't syncing a folder or holding any ports for this sandbox.</p>
    </div>
</template>
