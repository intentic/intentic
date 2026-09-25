<!-- A device's synced folders, ports and containers. What its agent is doing is <DeviceAgentGroup>'s, stated
     once above this list rather than a second time riding it. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import CopyButton from "../primitives/CopyButton.vue";
import Icon from "../primitives/Icon.vue";
import {
    backupState,
    backupTone,
    folderConflicts,
    folderState,
    folderTone,
    groupChips,
    groupNeedsAttention,
    groupStatus,
    type DeviceFolderRow,
    type DevicePortRow,
    type DeviceSandboxGroup,
    type DeviceSandboxRow,
    mirroringOff,
    portHolder,
    portNote,
    resourcesSummary,
    sandboxGroups,
    shortCommand,
} from "./deviceDetail.js";
import StatusBadge from "../feedback/StatusBadge.vue";
import { useT } from "../../i18n/index.js";

const t = useT();

const {
    pairings = [],
    ports = [],
    sandboxes = [],
    open = [],
    undivided = false,
    busy = [],
    selected = [],
} = defineProps<{
    pairings?: readonly DeviceFolderRow[];
    ports?: readonly DevicePortRow[];
    // Containers on the machine, when known (desktop's own `docker ps`, or a `host`-capability daemon read);
    // absent, every row is just a folder and its ports.
    sandboxes?: readonly DeviceSandboxRow[];
    // Sandbox ids the caller wants unfolded on arrival; the component unfolds anything needing attention on
    // its own, this is only for what it can't know.
    open?: readonly string[];
    // Drops the hairlines between sandboxes, for a caller that already separates rows itself, so two tiers
    // of hairline aren't drawn at the same weight.
    undivided?: boolean;
    // Sandbox ids something is being done to right now: their status glyph turns into a spinner, so a batch working
    // down the list shows where it is without a log per row.
    busy?: readonly string[];
    /** Sandbox ids the caller has ticked, tinted so a selection reads as one block rather than a column of boxes. */
    selected?: readonly string[];
}>();

defineSlots<{
    // A tick box for a caller that acts on several rows at once. Drawn outside the disclosure button, so choosing
    // a row never unfolds it, and first on the line, so a list mid-selection reads as a column of choices.
    select?: (props: { group: DeviceSandboxGroup }) => unknown;
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
    // One port's own verb, at the end of that port's line. Its own slot rather than another button under the
    // block: what it acts on is the number beside it, and a switch for 5440 sitting under a list of six ports
    // would be a switch for none of them.
    port?: (props: { group: DeviceSandboxGroup; port: DevicePortRow }) => unknown;
    // Turning file sync ON, for a row that has no pairing to hang `folder` under. Its own slot because the
    // emptiness is the prompt: a reader looking at a sandbox this device does not sync wants the folder field,
    // not a line telling them there is no folder.
    sync?: (props: { group: DeviceSandboxGroup }) => unknown;
    /** What follows the row while it's working: a run log, the result of the last action. */
    footer?: (props: { group: DeviceSandboxGroup }) => unknown;
}>();

const groups = computed(() => sandboxGroups(pairings, ports, sandboxes));

// Ink by outcome, not by whether the port reached localhost: one somebody told this device to leave alone is a
// quiet fact, and colouring it like a port that wanted localhost and lost would undo the whole distinction.
const portInk = (port: DevicePortRow): string =>
    port.state === `mirrored` ? `text-content` : port.state === `ignored` ? `text-subtle` : `text-warning`;

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

// The status glyph's words: its accessible name, and on hover the sentence behind it.
const statusWord = (group: DeviceSandboxGroup): string =>
    busy.includes(group.sandboxId)
        ? t(`ui.deviceDetail.working`)
        : groupStatus(group) === `running`
          ? t(`ui.deviceDetail.running`)
          : groupStatus(group) === `stopped`
            ? t(`ui.deviceDetail.stopped`)
            : t(`ui.deviceDetail.notRunningHere`);
const statusHint = (group: DeviceSandboxGroup): string =>
    groupStatus(group) === `elsewhere` && !busy.includes(group.sandboxId) ? t(`ui.deviceDetail.notRunningHereHint`) : statusWord(group);

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
        <div v-if="groups.length > 0" class="flex flex-col">
            <div
                v-for="group in groups"
                :key="group.sandboxId"
                :id="blockId(group)"
                class="flex flex-col gap-2 transition-colors duration-500"
                :class="[
                    undivided ? `pb-2 last:pb-0` : `border-t border-line-subtle py-1 first:border-t-0 first:pt-0 last:pb-0`,
                    flashing === blockId(group) ? `bg-warning/10` : ``,
                ]"
            >
                <!-- ONE QUIET LINE: tick box, one status glyph, the name, and the facts as glyphs with a count. The name
                     through the chevron is one button; the tick box and the verbs keep their own hit areas outside it. -->
                <!-- The app's own row tints (`ui-row-select`): a hover wash, and the selected tint for a ticked row. -->
                <div
                    class="ui-row-select -mx-2 flex min-w-0 items-center gap-x-2 rounded-md px-2"
                    :class="selected.includes(group.sandboxId) ? `ui-row-select-on` : undefined"
                >
                    <span v-if="$slots[`select`]" class="flex w-5 shrink-0 items-center justify-center"><slot name="select" :group="group" /></span>
                    <button
                        type="button"
                        class="group/row flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-left"
                        :aria-expanded="isOpen(group)"
                        :aria-controls="`${blockId(group)}-detail`"
                        @click="toggle(group)"
                    >
                        <!-- Where it stands on this machine, in one glyph: a filled dot runs, a ring is stopped, a cloud
                             lives somewhere else and only its files or ports are here. The words are its hover and its
                             accessible name, never a second label on the line. -->
                        <span class="flex w-4 shrink-0 items-center justify-center" v-tooltip.top="statusHint(group)">
                            <Icon v-if="busy.includes(group.sandboxId)" name="spinner" spin class="text-2xs text-muted" aria-hidden="true" />
                            <span v-else-if="groupStatus(group) === `running`" class="h-2 w-2 rounded-full bg-success" aria-hidden="true"></span>
                            <span v-else-if="groupStatus(group) === `stopped`" class="h-2 w-2 rounded-full border border-subtle" aria-hidden="true"></span>
                            <Icon v-else name="cloud" class="text-2xs text-subtle" aria-hidden="true" />
                            <span class="sr-only">{{ statusWord(group) }}</span>
                        </span>
                        <!-- The exact id is the hover, not a second name beside the first: it's what gets typed into a
                             terminal, and the open row states it with a copy button. -->
                        <span
                            class="min-w-0 truncate text-xs font-medium"
                            :class="groupStatus(group) === `elsewhere` ? `text-muted` : `text-content`"
                            v-tooltip.top="group.subtitle"
                            >{{ group.title }}</span
                        >
                        <slot name="badges" :group="group" />
                        <!-- What the closed line still answers, as glyphs: facts are uncoloured, a warning keeps its ink and
                             its words, since it's the reason the row unfolded itself. -->
                        <span class="ml-auto flex min-w-0 shrink items-center gap-x-2.5 pl-3">
                            <template v-if="!isOpen(group)">
                                <span
                                    v-for="chip in groupChips(group)"
                                    :key="chip.key"
                                    class="flex min-w-0 items-center gap-1 text-2xs"
                                    :class="chip.tone === `warning` ? `text-warning` : `shrink-0 text-subtle`"
                                    v-tooltip.top="chip.hint ?? chip.label"
                                >
                                    <Icon :name="chip.icon" class="shrink-0" aria-hidden="true" />
                                    <span v-if="chip.text !== ``" class="truncate" aria-hidden="true">{{ chip.text }}</span>
                                    <span class="sr-only">{{ chip.label }}</span>
                                </span>
                            </template>
                            <!-- The disclosure's own mark, at the end and only on demand: shown on hover or focus, and
                                 held while the row is open, so a resting list is names rather than a column of arrows. -->
                            <Icon
                                name="chevron-right"
                                class="shrink-0 text-2xs text-subtle transition group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
                                :class="isOpen(group) ? `rotate-90` : `opacity-0`"
                                aria-hidden="true"
                            />
                        </span>
                    </button>
                    <span v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-0.5"><slot name="actions" :group="group" /></span>
                </div>

                <!-- Facts start at one x, so a folder, ports and an image read as one block rather than loose lines. -->
                <div
                    v-if="isOpen(group)"
                    :id="`${blockId(group)}-detail`"
                    class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 pb-1"
                    :class="$slots[`select`] ? `pl-[3.25rem]` : `pl-6`"
                >
                    <template v-if="group.folder">
                        <span class="text-2xs text-subtle">{{ t(`ui.deviceDetail.folder`) }}</span>
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <!-- The answer this whole view exists for: which folder on this device is this sandbox's /work. -->
                            <!-- Wraps rather than truncates: the end of a path is what identifies it, which an ellipsis would eat first. -->
                            <span v-if="group.folder.localDir" class="break-all font-mono text-xs text-content">{{ group.folder.localDir }}</span>
                            <span v-else-if="group.folder.mode === `mirror`" class="text-xs text-subtle">
                                {{ t(`ui.deviceDetail.noFolderDeviceOnly`) }}
                            </span>
                            <span v-else class="text-xs text-subtle">{{ t(`ui.deviceDetail.noFolderSynced`) }}</span>
                            <CopyButton v-if="group.folder.localDir" :text="group.folder.localDir" v-tooltip.top="t(`ui.deviceDetail.copyPath`)" />
                            <!-- Silent when healthy (`watching`): the agent group above this list already says the sync is alive. -->
                            <StatusBadge
                                v-if="folderState(group.folder) && !restingSync(group.folder)"
                                :variant="folderTone(folderState(group.folder))"
                                size="xs"
                                :label="folderState(group.folder) ?? ``"
                            />
                            <!-- Silent when healthy, spoken when not: a stopped backup costs nothing until the sandbox is gone, so it's named rather than left to be noticed. -->
                            <StatusBadge
                                v-if="backupState(group.folder) && !restingBackup(group.folder)"
                                :variant="backupTone(backupState(group.folder))"
                                size="xs"
                                :label="t(`ui.deviceDetail.backup`, { folder: backupState(group.folder) })"
                            />
                            <!-- Two-way-safe flags conflicts rather than clobbering; nothing else in the product has ever surfaced one waiting. -->
                            <StatusBadge
                                v-if="group.folder.conflicts"
                                variant="warning"
                                size="xs"
                                :label="`${group.folder.conflicts} ${group.folder.conflicts === 1 ? `conflict` : `conflicts`}`"
                            />
                        </div>
                        <!-- The count expands to show sync impact and the recovery action. -->
                        <div v-if="conflicts.get(group.sandboxId)" class="col-start-2 flex min-w-0 flex-col gap-1">
                            <p class="text-xs text-muted">{{ conflicts.get(group.sandboxId)?.lead }}</p>
                            <!-- Each entry is a path plus what happened to it; a tight gap on a narrow card would run one entry into the next. -->
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
                            <!-- Counted against the machine's own total, shown only under a real list; a too-old agent gets a note instead. -->
                            <p
                                v-if="(conflicts.get(group.sandboxId)?.rows.length ?? 0) > 0 && (conflicts.get(group.sandboxId)?.more ?? 0) > 0"
                                class="text-2xs text-subtle"
                            >
                                {{ t(`ui.deviceDetail.more`, { more: conflicts.get(group.sandboxId)?.more }) }}
                            </p>
                            <p v-if="conflicts.get(group.sandboxId)?.note" class="text-2xs text-subtle">
                                {{ conflicts.get(group.sandboxId)?.note }}
                            </p>
                        </div>
                        <!-- What to do about this folder, under it rather than in the row's own verbs, which act on the container. -->
                        <span v-if="$slots[`folder`]" class="empty:hidden col-start-2 -ml-2.5 flex flex-wrap items-center gap-x-1 gap-y-1">
                            <slot name="folder" :group="group" />
                        </span>
                    </template>

                    <!-- Nothing synced yet: the offer to start, in the same value column the folder would have used. -->
                    <template v-if="!group.folder && $slots[`sync`]">
                        <span class="text-2xs text-subtle">{{ t(`ui.deviceDetail.sync`) }}</span>
                        <div class="min-w-0"><slot name="sync" :group="group" /></div>
                    </template>

                    <!-- Survives having no ports: an empty list has two causes (nothing served, or mirroring off). -->
                    <template v-if="group.ports.length > 0 || mirroringOff(group.folder)">
                        <span class="text-2xs text-subtle">{{ t(`ui.deviceDetail.ports`) }}</span>
                        <div class="flex min-w-0 flex-col gap-1">
                            <!-- Said as a state, not a fault: quiet ink, no badge, since somebody threw this switch on purpose. -->
                            <p v-if="mirroringOff(group.folder)" class="text-xs text-muted">
                                {{ t(`ui.deviceDetail.offDeviceIsntPutting`) }}
                            </p>
                            <!-- Ports use aligned address and status columns; colour marks unreachable ports. -->
                            <!-- Suppressed while mirroring is off: a stale `localhost:` reading here would contradict the sentence above it. -->
                            <div v-else class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">
                                <template v-for="port in group.ports" :key="`${port.port}:${port.state}`">
                                    <!-- Only a port that reached localhost is prefixed with it; one that didn't is a bare number. -->
                                    <span class="shrink-0 font-mono text-xs" :class="portInk(port)"
                                        >{{ port.state === `mirrored` ? t(`ui.deviceDetail.localhost`) : `` }}{{ port.port }}</span
                                    >
                                    <span class="flex min-w-0 items-baseline gap-1">
                                        <!-- What's listening, named rather than quoted in full; the whole command line is one hover away. -->
                                        <span
                                            v-if="port.state === `mirrored`"
                                            class="min-w-0 truncate font-mono text-xs text-subtle"
                                            :title="port.command"
                                            >{{ shortCommand(port.command) }}</span
                                        >
                                        <span v-else class="min-w-0 text-xs text-muted">
                                            {{ portNote(port, portHolder(groups, port), shortCommand(port.command)) }}
                                            <!-- Goes to the holder's own block, where its Stop button lives, rather than naming a winner with nowhere to go. -->
                                            <button
                                                v-if="portHolder(groups, port)"
                                                type="button"
                                                class="ml-1 rounded underline decoration-dotted underline-offset-2 transition-colors hover:text-content"
                                                @click="showHolder(portHolder(groups, port)!)"
                                            >
                                                {{ t(`ui.deviceDetail.show`) }}
                                            </button>
                                        </span>
                                        <!-- The caller's own verb for this one number; the component knows nothing about what it does. -->
                                        <slot name="port" :group="group" :port="port" />
                                    </span>
                                </template>
                            </div>
                            <!-- Cancels the small text button's own padding, so its words land back in the block's one value column. -->
                            <span v-if="$slots[`ports`]" class="-ml-2.5 flex flex-wrap items-center gap-x-1 gap-y-1 empty:hidden">
                                <slot name="ports" :group="group" />
                            </span>
                        </div>
                    </template>

                    <!-- The exact id the line only carries on hover: what gets typed into a terminal, so it can be copied. -->
                    <template v-if="group.subtitle">
                        <span class="text-2xs text-subtle">{{ t(`ui.deviceDetail.id`) }}</span>
                        <div class="flex min-w-0 items-center gap-x-2">
                            <span class="truncate font-mono text-xs text-subtle">{{ group.subtitle }}</span>
                            <CopyButton :text="group.subtitle" v-tooltip.top="t(`ui.deviceDetail.copyId`)" />
                        </div>
                    </template>

                    <!-- Last, and quietest: the least-often-read fact, at the block's one value size rather than its own. -->
                    <template v-if="group.sandbox">
                        <span class="text-2xs text-subtle">{{ t(`ui.deviceDetail.image`) }}</span>
                        <span class="truncate font-mono text-xs text-subtle" :title="group.sandbox.image">{{ group.sandbox.image }}</span>
                    </template>

                    <!-- The caps and privileges docker enforces, only when the caller inspected the container for them. -->
                    <template v-if="group.sandbox && resourcesSummary(group.sandbox)">
                        <span class="text-2xs text-subtle">{{ t(`ui.deviceDetail.share`) }}</span>
                        <span class="truncate text-xs text-subtle">{{ resourcesSummary(group.sandbox) }}</span>
                    </template>
                </div>

                <!-- Outside the disclosure: a verb pressed on a folded row must still show what it's doing. -->
                <div v-if="$slots[`footer`]" class="empty:hidden" :class="$slots[`select`] ? `pl-[3.25rem]` : `pl-6`">
                    <slot name="footer" :group="group" />
                </div>
            </div>
        </div>

        <p v-if="groups.length === 0" class="text-xs text-muted">{{ t(`ui.deviceDetail.deviceIsntSyncingFolder`) }}</p>
    </div>
</template>
