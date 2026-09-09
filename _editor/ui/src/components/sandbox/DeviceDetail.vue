<!--
    What one device is doing for a sandbox: synced folders, forwarded ports, containers, and whether the agent behind them is alive. Body only; the
    caller frames it (a manager window section, an expanded row). One row per sandbox, container included, hairline-separated rather than boxed.
    Shapes live in deviceDetail.ts, structurally typed rather than importing the sandbox contract.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, useSlots, watch } from "vue";
import CopyButton from "../primitives/CopyButton.vue";
import Icon from "../primitives/Icon.vue";
import {
    backupState,
    backupTone,
    folderConflicts,
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
    resourcesSummary,
    sandboxGroups,
    shortCommand,
} from "./deviceDetail.js";
import StatusBadge from "../feedback/StatusBadge.vue";

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
    // Containers on the machine, when known (desktop's own `docker ps`, or a `host`-capability daemon read);
    // absent, every row is just a folder and its ports.
    sandboxes?: readonly DeviceSandboxRow[];
    // The device's agent, for a caller with nowhere else to show it; the web Devices tab states this itself
    // above the list, so it passes none.
    agent?: DeviceAgentState | undefined;
    // Sandbox ids the caller wants unfolded on arrival; the component unfolds anything needing attention on
    // its own, this is only for what it can't know.
    open?: readonly string[];
    // Drops the hairlines between sandboxes, for a caller that already separates rows itself, so two tiers
    // of hairline aren't drawn at the same weight.
    undivided?: boolean;
}>();

defineSlots<{
    /** What the caller calls this list, on the same line as the agent's own state, when passed. */
    heading?: () => unknown;
    /** Anything else worth saying about one sandbox, beside its name. */
    badges?: (props: { group: DeviceSandboxGroup }) => unknown;
    /** What can be done to it, right-aligned on the same line; the caller owns the verbs. */
    actions?: (props: { group: DeviceSandboxGroup }) => unknown;
    // Verbs for this row's file sync, under the folder line (the twin of `ports` below): pausing a sync and
    // stopping a container are different acts and must not share one button cluster.
    folder?: (props: { group: DeviceSandboxGroup }) => unknown;
    // Verbs for this row's ports, at the end of the ports line rather than in `actions`: a mirroring toggle
    // beside the container's own Stop would read as the same stop.
    ports?: (props: { group: DeviceSandboxGroup }) => unknown;
    /** What follows the row while it's working: a run log, the result of the last action. */
    footer?: (props: { group: DeviceSandboxGroup }) => unknown;
    // Restarting this device's agent, beside the state that asks for it. A caller that can reach the machine
    // (this app IS it; the web tab has the device's socket) fills this, and the two-command prose below is
    // dropped: a command to type is for a machine nobody here can act on.
    agentAction?: () => unknown;
}>();

const slots = useSlots();
// Whether a click can close this agent's state, which decides between the caller's button and prose naming the two
// commands. Read off the slot, not a prop: a caller either has a way to that machine or it doesn't.
const canRestart = computed(() => slots[`agentAction`] !== undefined);
// The states a restart closes: a dead loop, a stalled one, or one on a build this machine has already replaced. Judged
// here rather than by the caller, so its button appears in the same three cases the prose named.
const restartOwed = computed(() => agent !== undefined && (!agent.running || agent.stalled === true || agent.staleBuild !== undefined));

const groups = computed(() => sandboxGroups(pairings, ports, sandboxes));

// Every row's conflict block, derived once and keyed by sandbox id rather than recomputed per template read.
const conflicts = computed(() => new Map(groups.value.map((group) => [group.sandboxId, folderConflicts(group.folder)])));

// Which rows unfold on their own: whatever needs attention, plus what the caller named. Not "stopped":
// plenty of sandboxes are stopped on purpose.
const autoOpen = computed(() => new Set([...open, ...groups.value.filter(groupNeedsAttention).map((group) => group.sandboxId)]));

// Two sets, not one: a single "open" set re-seeded from the rule on every poll would re-open a row the
// reader just folded. These record the reader's own gestures, so the rule only decides where they made none.
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
// A row the caller newly names (e.g. a search hit) must open, not flip, even if the reader had folded
// it by hand.
watch(
    () => [...open].join(`|`),
    () => (folded.value = new Set([...folded.value].filter((id) => !open.includes(id)))),
);

// A port shows no fill or colour: with a chip on every port plus a green running dot, colour had stopped
// signalling anything. Only a port that reached localhost is shown as `localhost:<port>`.

// A healthy sync says nothing in colour: Mutagen's resting word stays, but only a state worth noticing keeps a badge.
const restingSync = (folder: DeviceFolderRow): boolean => folderTone(folderState(folder)) === `success`;

// Same rule for backup: silent when healthy, since another quiet grey word here would be noise.
const restingBackup = (folder: DeviceFolderRow): boolean => backupTone(backupState(folder)) === `success`;

// Scrolls to and flashes the block of the sandbox holding a contested port; scoped by `uid` since a page
// can render one of these per device and ids would otherwise collide.
// Long enough to find the row after the scroll settles, short enough to be gone before it's furniture.
const FLASH_MS = 1600;

const uid = useId();
const blockId = (group: DeviceSandboxGroup): string => `${uid}-${group.sandboxId}`;
const flashing = ref<string>();
let flashTimer: ReturnType<typeof setTimeout> | undefined;

const showHolder = (holder: DeviceSandboxGroup): void => {
    const id = blockId(holder);
    // Opened before it's jumped to, or scrolling to a closed row is the same dead end the link exists to fix.
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
        <!--
            Agent first: it decides whether everything below is still true (a dead loop means new ports and commits
            stop appearing, with no other change on screen).
        -->
        <div v-if="agent || $slots[`heading`]" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <slot name="heading" />
            <div v-if="agent" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <!--
                    Alive but not working: amber like stopped, since it's the same errand and the difference (a restart
                    is
                    owed despite nothing looking dead) isn't otherwise visible.
                -->
                <template v-if="agent.stalled === true">
                    <StatusBadge variant="warning" :dot="true" size="xs" label="agent stalled" />
                    <span class="text-xs text-warning">
                        Its process is alive but has stopped making rounds, so ports and commits below may be out of date.
                        <template v-if="!canRestart">
                            Restart it with <span class="font-mono">intentic-machine run --stop</span> then
                            <span class="font-mono">intentic-machine run</span>
                        </template>
                    </span>
                </template>
                <template v-else-if="agent.running">
                    <span class="inline-flex items-center gap-1.5 text-xs text-muted">
                        <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
                        Agent running
                    </span>
                    <span v-if="agent.pid !== undefined" class="font-mono text-2xs text-subtle">pid {{ agent.pid }}</span>
                    <!--
                        Working on a build this machine has already replaced; not a badge, since nothing is broken and
                        only a
                        restart is owed.
                    -->
                    <span v-if="agent.staleBuild !== undefined" class="text-xs text-warning">
                        <template v-if="agent.staleBuild.running">
                            on <span class="font-mono">{{ agent.staleBuild.running }}</span>, while
                            <span class="font-mono">{{ agent.staleBuild.installed }}</span> is installed here
                        </template>
                        <!-- Too old to report which build it's running; that absence is itself the answer. -->
                        <template v-else>
                            on a build older than the <span class="font-mono">{{ agent.staleBuild.installed }}</span> installed here
                        </template>
                        <!--
                            The two commands stay whole across a wrap; this sentence is long enough to break
                            mid-command otherwise.
                        -->
                        <!-- The colon hugs the word: a `<template>` boundary opening on the next line inserts a space before it. -->
                        — it keeps the build it started with, so it owes a restart<template v-if="!canRestart"
                            >: <span class="font-mono whitespace-nowrap">intentic-machine run --stop</span> then
                            <span class="font-mono whitespace-nowrap">intentic-machine run</span></template
                        >
                    </span>
                </template>
                <template v-else>
                    <StatusBadge variant="warning" :dot="true" size="xs" label="agent stopped" />
                    <span class="text-xs text-warning">
                        Nothing is reaching this device's folders or ports until it restarts<template v-if="!canRestart"
                            >: <span class="font-mono">intentic-machine run</span></template
                        >
                    </span>
                </template>
                <!-- The caller's own way to that machine, beside whichever state is asking for a restart. -->
                <slot v-if="restartOwed" name="agentAction" />
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
                <!--
                    The chevron and name are one button; verbs keep their own hit areas outside it. Not a
                    <DisclosureRow>:
                    this is a report entry inside an already-open row, so it takes no open-row wash of its own — only
                    the
                    chevron's angle and the block's indent show it's open. Matches <DisclosureRow>'s own spelling
                    (rotation,
                    aria-expanded/controls, indent) so the two read as one convention.
                -->
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
                        <!--
                            Running is a dot alone, the resting state of a healthy row; stopped keeps its word beside
                            it.
                        -->
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
                        <!--
                            The exact id, kept and demoted: the title is the friendliest name available, and this is
                            what gets
                            typed into a terminal.
                        -->
                        <span v-if="group.subtitle" class="hidden shrink-0 truncate font-mono text-2xs text-subtle sm:inline">
                            {{ group.subtitle }}
                        </span>
                        <!--
                            Running is said by the dot; stopped needs the word, since a grey dot alone reads as nothing
                            to see.
                        -->
                        <span v-if="group.sandbox && !group.sandbox.running" class="shrink-0 text-2xs text-muted">stopped</span>
                        <!--
                            A pairing with no container: says so explicitly, rather than rendering a bare row with no
                            state and no verbs.
                        -->
                        <span v-else-if="!group.sandbox" class="shrink-0 text-2xs text-muted">not running here</span>
                        <slot name="badges" :group="group" />
                        <!--
                            What the closed line still answers: facts are counted and uncoloured, a warning is why the
                            row unfolded itself.
                        -->
                        <span v-if="!isOpen(group)" class="ml-auto flex min-w-0 shrink items-center gap-x-2 pl-2">
                            <span v-for="fact in groupSummary(group).facts" :key="fact" class="shrink-0 text-2xs text-subtle">{{ fact }}</span>
                            <span v-for="warning in groupSummary(group).warnings" :key="warning" class="truncate text-2xs text-warning">
                                {{ warning }}
                            </span>
                        </span>
                    </button>
                    <span v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-0.5"><slot name="actions" :group="group" /></span>
                </div>

                <!-- Facts start at one x, so a folder, ports and an image read as one block rather than loose lines. -->
                <div
                    v-if="isOpen(group)"
                    :id="`${blockId(group)}-detail`"
                    class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 pl-5"
                >
                    <template v-if="group.folder">
                        <span class="text-2xs text-subtle">Folder</span>
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <!--
                                The answer this whole view exists for: which folder on this device is this sandbox's
                                /work.
                            -->
                            <!--
                                Wraps rather than truncates: the end of a path is what identifies it, which an ellipsis
                                would eat first.
                            -->
                            <span v-if="group.folder.localDir" class="break-all font-mono text-xs text-content">{{ group.folder.localDir }}</span>
                            <span v-else-if="group.folder.mode === `mirror`" class="text-xs text-subtle">
                                no folder: this device only mirrors ports
                            </span>
                            <span v-else class="text-xs text-subtle">no folder synced</span>
                            <CopyButton v-if="group.folder.localDir" :text="group.folder.localDir" v-tooltip.top="`Copy path`" />
                            <!--
                                Silent when healthy (`watching`): the machine's own "agent running" line already says
                                the sync is alive.
                            -->
                            <StatusBadge
                                v-if="folderState(group.folder) && !restingSync(group.folder)"
                                :variant="folderTone(folderState(group.folder))"
                                size="xs"
                                :label="folderState(group.folder) ?? ``"
                            />
                            <!--
                                Silent when healthy, spoken when not: a stopped backup costs nothing until the sandbox
                                is gone, so
                                it's named rather than left to be noticed.
                            -->
                            <StatusBadge
                                v-if="backupState(group.folder) && !restingBackup(group.folder)"
                                :variant="backupTone(backupState(group.folder))"
                                size="xs"
                                :label="`backup: ${backupState(group.folder)}`"
                            />
                            <!--
                                Two-way-safe flags conflicts rather than clobbering; nothing else in the product has
                                ever surfaced one waiting.
                            -->
                            <StatusBadge
                                v-if="group.folder.conflicts"
                                variant="warning"
                                size="xs"
                                :label="`${group.folder.conflicts} ${group.folder.conflicts === 1 ? `conflict` : `conflicts`}`"
                            />
                        </div>
                        <!--
                            What a bare count can't say: what happened, what it costs (nothing overwritten, those paths
                            just
                            stopped syncing), and what ends it (make both copies agree). Placed under the path, since
                            this is
                            prose about the folder.
                        -->
                        <div v-if="conflicts.get(group.sandboxId)" class="col-start-2 flex min-w-0 flex-col gap-1">
                            <p class="text-xs text-muted">{{ conflicts.get(group.sandboxId)?.lead }}</p>
                            <!--
                                Each entry is a path plus what happened to it; a tight gap on a narrow card would run
                                one entry into the next.
                            -->
                            <ul class="flex min-w-0 flex-col gap-1">
                                <li
                                    v-for="row in conflicts.get(group.sandboxId)?.rows ?? []"
                                    :key="row.path"
                                    class="flex min-w-0 flex-wrap items-baseline gap-x-2"
                                >
                                    <span class="break-all font-mono text-2xs text-content">{{ row.path }}</span>
                                    <span v-if="row.note !== ``" class="text-2xs text-subtle">{{ row.note }}</span>
                                </li>
                            </ul>
                            <!--
                                Counted against the machine's own total, shown only under a real list; a too-old agent
                                gets a note instead.
                            -->
                            <p
                                v-if="(conflicts.get(group.sandboxId)?.rows.length ?? 0) > 0 && (conflicts.get(group.sandboxId)?.more ?? 0) > 0"
                                class="text-2xs text-subtle"
                            >
                                … and {{ conflicts.get(group.sandboxId)?.more }} more
                            </p>
                            <p v-if="conflicts.get(group.sandboxId)?.note" class="text-2xs text-subtle">
                                {{ conflicts.get(group.sandboxId)?.note }}
                            </p>
                        </div>
                        <!--
                            What to do about this folder, under it rather than in the row's own verbs, which act on the
                            container.
                        -->
                        <span
                            v-if="$slots[`folder`]"
                            class="empty:hidden col-start-2 -ml-2.5 flex flex-wrap items-center gap-x-1 gap-y-1"
                        >
                            <slot name="folder" :group="group" />
                        </span>
                    </template>

                    <!--
                        Survives having no ports: an empty list has two causes (nothing served, or mirroring off), and
                        only
                        the second is worth a line explaining why localhost looks empty.
                    -->
                    <template v-if="group.ports.length > 0 || mirroringOff(group.folder)">
                        <span class="text-2xs text-subtle">Ports</span>
                        <div class="flex min-w-0 flex-col gap-1">
                            <!--
                                Said as a state, not a fault: quiet ink, no badge, since somebody threw this switch on
                                purpose.
                            -->
                            <p v-if="mirroringOff(group.folder)" class="text-xs text-muted">
                                Off: this device isn't putting this sandbox's ports on its own localhost. File syncing is unaffected.
                            </p>
                            <!--
                                One port per line in two aligned columns (address, then what's on it or why it never
                                arrived); no
                                fills, colour is reserved for a port that can't be reached.
                            -->
                            <!--
                                Suppressed while mirroring is off: a stale `localhost:` reading here would contradict
                                the sentence above it.
                            -->
                            <div v-else class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">
                                <template v-for="port in group.ports" :key="`${port.port}:${port.state}`">
                                    <!--
                                        Only a port that reached localhost is prefixed with it; one that didn't is a
                                        bare number.
                                    -->
                                    <span class="shrink-0 font-mono text-xs" :class="port.state === `mirrored` ? `text-content` : `text-warning`"
                                        >{{ port.state === `mirrored` ? `localhost:` : `` }}{{ port.port }}</span
                                    >
                                    <!--
                                        What's listening, named rather than quoted in full; the whole command line is
                                        one hover away.
                                    -->
                                    <span
                                        v-if="port.state === `mirrored`"
                                        class="min-w-0 truncate font-mono text-xs text-subtle"
                                        :title="port.command"
                                        >{{ shortCommand(port.command) }}</span
                                    >
                                    <span v-else class="min-w-0 text-xs text-muted">
                                        {{ portNote(port, portHolder(groups, port), shortCommand(port.command)) }}
                                        <!--
                                            Goes to the holder's own block, where its Stop button lives, rather than
                                            naming a winner with nowhere
                                            to go. Absent when the holder isn't on this report.
                                        -->
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
                            <!--
                                Cancels the small text button's own padding, so its words land back in the block's one
                                value column.
                            -->
                            <span v-if="$slots[`ports`]" class="-ml-2.5 flex flex-wrap items-center gap-x-1 gap-y-1 empty:hidden">
                                <slot name="ports" :group="group" />
                            </span>
                        </div>
                    </template>

                    <!--
                        Last, and quietest: the least-often-read fact, at the block's one value size rather than its
                        own.
                    -->
                    <template v-if="group.sandbox">
                        <span class="text-2xs text-subtle">Image</span>
                        <span class="truncate font-mono text-xs text-subtle" :title="group.sandbox.image">{{ group.sandbox.image }}</span>
                    </template>

                    <!-- The caps and privileges docker enforces, only when the caller inspected the container for them. -->
                    <template v-if="group.sandbox && resourcesSummary(group.sandbox)">
                        <span class="text-2xs text-subtle">Share</span>
                        <span class="truncate text-xs text-subtle">{{ resourcesSummary(group.sandbox) }}</span>
                    </template>
                </div>

                <!-- Outside the disclosure: a verb pressed on a folded row must still show what it's doing. -->
                <div v-if="$slots[`footer`]" class="empty:hidden pl-5"><slot name="footer" :group="group" /></div>
            </div>
        </div>

        <p v-if="groups.length === 0" class="text-xs text-muted">This device isn't syncing a folder or holding any ports for this sandbox.</p>
    </div>
</template>
