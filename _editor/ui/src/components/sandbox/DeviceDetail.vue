<!-- A device's synced folders, ports and containers. What its agent is doing is <DeviceAgentGroup>'s, stated
     once above this list rather than a second time riding it. -->
<script setup lang="ts">
import { Comment, computed, Fragment, isVNode, onBeforeUnmount, ref, Text, useId, type VNode, watch } from "vue";
import CopyButton from "../primitives/CopyButton.vue";
import Icon from "../primitives/Icon.vue";
import SandboxLogo from "./SandboxLogo.vue";
import {
    backupState,
    backupTone,
    type CardPart,
    type CardTone,
    cardOrder,
    cardStatus,
    cardSubline,
    filesLine,
    folderConflicts,
    folderState,
    folderTone,
    groupNeedsAttention,
    type DeviceFolderRow,
    type DevicePortRow,
    type DeviceSandboxGroup,
    type DeviceSandboxRow,
    mirroringOff,
    portHolder,
    portNote,
    portsLine,
    sandboxGroups,
    shortCommand,
} from "./deviceDetail.js";
import StatusBadge from "../feedback/StatusBadge.vue";
import { useT } from "../../i18n/index.js";
import type { Tip, TooltipValue } from "../../lib/tooltip.js";

const t = useT();

const {
    pairings = [],
    ports = [],
    sandboxes = [],
    open = [],
    busy = [],
    selected = [],
    leading = [],
} = defineProps<{
    pairings?: readonly DeviceFolderRow[];
    ports?: readonly DevicePortRow[];
    // Containers on the machine, when known (desktop's own `docker ps`, or a `host`-capability daemon read);
    // absent, every row is just a folder and its ports.
    sandboxes?: readonly DeviceSandboxRow[];
    // Sandbox ids the caller wants unfolded on arrival; the component unfolds anything needing attention on
    // its own, this is only for what it can't know.
    open?: readonly string[];
    // Kept for callers written against the row list, which drew hairlines between sandboxes: cards need none.
    undivided?: boolean;
    // Sandbox ids something is being done to right now: their status glyph turns into a spinner, so a batch working
    // down the list shows where it is without a log per row.
    busy?: readonly string[];
    /** Sandbox ids the caller has ticked, tinted so a selection reads as one block rather than a column of boxes. */
    selected?: readonly string[];
    /** Sandbox ids drawn first, ahead of the running ones: the sandbox serving the page. */
    leading?: readonly string[];
}>();

// Each slot returns what Vue's own `Slot` returns, the nodes it drew: `offersSync` reads them to tell an offer from
// nothing.
const slots = defineSlots<{
    // The card's picture: the sandbox's own logo where the caller knows it. Absent, a monogram of its name.
    lead?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // A tick box for a caller that acts on several rows at once. Drawn outside the disclosure button, so choosing
    // a row never unfolds it, and first on the line, so a list mid-selection reads as a column of choices.
    select?: (props: { group: DeviceSandboxGroup }) => VNode[];
    /** Anything else worth saying about one sandbox, beside its name. */
    badges?: (props: { group: DeviceSandboxGroup }) => VNode[];
    /** What can be done to it, right-aligned on the same line; the caller owns the verbs. */
    actions?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // Verbs for this row's file sync, at the end of the folder's line (the twin of `ports` below): pausing a sync
    // and stopping a container are different acts and must not share one button cluster.
    folder?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // Which side of a many-sided machine holds the folder, said among the folder's own facts under its path: the
    // path alone says it, but not in words.
    where?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // The verbs that settle this folder's conflicts, at the foot of the block that explains them: they answer that
    // block, not the folder as a whole.
    conflicts?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // Verbs for this row's ports, at the end of the ports line rather than in `actions`: a mirroring toggle
    // beside the container's own Stop would read as the same stop.
    ports?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // One port's own verb, at the end of that port's line. Its own slot rather than another button under the
    // block: what it acts on is the number beside it, and a switch for 5440 sitting under a list of six ports
    // would be a switch for none of them.
    port?: (props: { group: DeviceSandboxGroup; port: DevicePortRow }) => VNode[];
    // Turning file sync ON, for a row that has no pairing to hang `folder` under. Its own slot because the
    // emptiness is the prompt: a reader looking at a sandbox this device does not sync wants the folder field,
    // not a line telling them there is no folder.
    sync?: (props: { group: DeviceSandboxGroup }) => VNode[];
    /** What follows the row while it's working: a run log, the result of the last action. */
    footer?: (props: { group: DeviceSandboxGroup }) => VNode[];
}>();

const groups = computed(() => sandboxGroups(pairings, ports, sandboxes));

// The open card's geometry, read in one place. A name column wide enough for its longest name ("Container"), each
// value's first line one small button tall (26px) so a value, its name and the verbs beside it share a centre, and
// the verbs at the right edge of the line they act on. A value keeps a floor where it is drawn (a path its own width,
// prose `min-w-48`), so a narrow card moves the verbs onto a line of their own rather than squeezing a path to a word
// per line; `ml-auto` keeps them at the right edge there too.
const SECTION = `flex min-w-0 items-start gap-3`;
const LABEL = `flex h-6.5 w-16 shrink-0 items-center text-2xs text-subtle`;
const LINE = `flex min-h-6.5 min-w-0 items-center`;
const VERBS = `ml-auto flex min-h-6.5 shrink-0 flex-wrap items-center justify-end gap-1 empty:hidden`;
// The closed card's two lines share the open card's name column, so opening one moves nothing sideways.
const FACT = `flex min-w-0 items-baseline gap-3`;
const FACT_LABEL = `w-16 shrink-0 text-2xs text-subtle`;

// Everything under the header starts under the NAME: past the tick box when there is one, then the picture.
const indent = (): string => (slots.select === undefined ? `pl-10.5` : `pl-17.5`);

const TONE = { content: `text-content`, muted: `text-muted`, subtle: `text-subtle`, warning: `text-warning` } as const satisfies Record<CardTone, string>;
const partClass = (part: CardPart): string[] => [TONE[part.tone], part.mono === true ? `font-mono` : ``];

// Whether a slot, rendered for this row, draws anything. A caller's `v-if` that came up false still renders, as a
// comment, so "the caller passed #sync" is not "this row has an offer": every other row drew its name over nothing.
const draws = (nodes: readonly VNode[]): boolean =>
    nodes.some((node) =>
        node.type === Comment
            ? false
            : node.type === Text
              ? String(node.children ?? ``).trim() !== ``
              : node.type === Fragment
                ? Array.isArray(node.children) && draws(node.children.filter(isVNode))
                : true,
    );
const offersSync = (group: DeviceSandboxGroup): boolean => draws(slots.sync?.({ group }) ?? []);

// The image a container runs, for the hover over its line.
const imageOf = (sandbox: DeviceSandboxRow): Tip => ({
    title: t(`ui.deviceDetail.container`),
    rows: [{ label: t(`ui.deviceDetail.image`), value: sandbox.image }],
});

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

// Read at render: a machine's report is re-read on the page's own poll, and a probation that ended drops off its next one.
const sublineOf = (group: DeviceSandboxGroup): string[] => cardSubline(group, Date.now());

// The list as it is read (see `cardOrder`): every sandbox that is doing something here, then, apart, the idle ones.
const bands = computed(() => cardOrder(groups.value, leading));

// The idle band folds away under a header that counts it, so leftovers stop being half of a busy machine's list. It
// opens by itself on a machine with nothing else to show, and whenever one of its rows is named by the caller or
// ticked, so a selection is never hidden.
const idleChosen = ref<boolean>();
const idleShown = computed(
    () =>
        idleChosen.value ??
        (bands.value.active.length === 0 || bands.value.idle.some((group) => open.includes(group.sandboxId) || selected.includes(group.sandboxId))),
);
// One list to draw, the idle band's header in it as an item of its own, so a card is written once.
type Item = { readonly kind: `card`; readonly group: DeviceSandboxGroup } | { readonly kind: `idle`; readonly count: number };
const items = computed<Item[]>(() => [
    ...bands.value.active.map((group): Item => ({ kind: `card`, group })),
    ...(bands.value.idle.length === 0 ? [] : [{ kind: `idle`, count: bands.value.idle.length } satisfies Item]),
    ...(idleShown.value ? bands.value.idle.map((group): Item => ({ kind: `card`, group })) : []),
]);
const itemKey = (item: Item): string => (item.kind === `card` ? item.group.sandboxId : `:idle`);


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
    <div class="flex flex-col gap-2">
        <template v-for="item in items" :key="itemKey(item)">
            <!-- The idle band's own header: what these are, how many, and the way to see them. -->
            <div v-if="item.kind === `idle`" class="mt-3 flex min-w-0 flex-col gap-0.5 px-1">
                <button
                    type="button"
                    class="flex w-fit cursor-pointer items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-content"
                    :aria-expanded="idleShown"
                    @click="idleChosen = !idleShown"
                >
                    <Icon name="chevron-right" class="shrink-0 text-2xs transition" :class="idleShown ? `rotate-90` : ``" aria-hidden="true" />
                    {{ t(`ui.deviceDetail.idle`) }}
                    <span class="font-normal text-subtle">{{ item.count }}</span>
                </button>
                <p class="pl-4 text-2xs text-subtle">{{ t(`ui.deviceDetail.idleHint`) }}</p>
            </div>

            <!-- ONE CARD PER SANDBOX: a header that says who it is and where it stands, a line for its files and one
                 for its ports, and on demand the evidence and the verbs for each. -->
            <section
                v-else
                :id="blockId(item.group)"
                class="ui-row-select flex min-w-0 flex-col gap-1.5 rounded-xl bg-card px-4 py-3 shadow-sm transition-colors duration-500"
                :class="[
                    selected.includes(item.group.sandboxId) ? `ui-row-select-on` : undefined,
                    flashing === blockId(item.group) ? `bg-warning/10` : undefined,
                ]"
                :aria-label="item.group.title"
            >
                <!-- The header: tick box, then the disclosure (picture, name, standing), then the caller's verbs. The tick
                     box and the verbs keep their own hit areas outside the disclosure. -->
                <div class="flex min-w-0 items-center gap-x-2">
                    <span v-if="$slots[`select`]" class="flex w-5 shrink-0 items-center justify-center"><slot name="select" :group="item.group" /></span>
                    <button
                        type="button"
                        class="group/row flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                        :aria-expanded="isOpen(item.group)"
                        :aria-controls="`${blockId(item.group)}-detail`"
                        @click="toggle(item.group)"
                    >
                        <span class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-content/5">
                            <slot name="lead" :group="item.group"><SandboxLogo :name="item.group.title" :size="18" /></slot>
                        </span>
                        <!-- The exact id is the hover, not a second name beside the first; the line under it says it in full. -->
                        <span
                            class="min-w-0 truncate text-sm font-medium"
                            :class="item.group.sandbox === undefined ? `text-muted` : `text-content`"
                            v-tooltip.top="item.group.subtitle"
                            >{{ item.group.title }}</span
                        >
                        <span class="flex shrink-0 items-center" v-tooltip.top="cardStatus(item.group, busy.includes(item.group.sandboxId)).hint">
                            <StatusBadge
                                :variant="cardStatus(item.group, busy.includes(item.group.sandboxId)).variant"
                                size="xs"
                                :dot="!busy.includes(item.group.sandboxId)"
                                :label="cardStatus(item.group, busy.includes(item.group.sandboxId)).label"
                            >
                                <Icon v-if="busy.includes(item.group.sandboxId)" name="spinner" spin class="text-2xs" aria-hidden="true" />
                                {{ cardStatus(item.group, busy.includes(item.group.sandboxId)).label }}
                            </StatusBadge>
                        </span>
                        <StatusBadge v-if="item.group.sandbox?.tunnelRunning === false" variant="warning" size="xs" :label="t(`ui.deviceDetail.tunnelOff`)" class="shrink-0" />
                        <slot name="badges" :group="item.group" />
                        <!-- The disclosure's own mark, held at the end of the header. -->
                        <Icon
                            name="chevron-right"
                            class="ml-auto shrink-0 text-2xs text-subtle transition group-hover/row:text-content"
                            :class="isOpen(item.group) ? `rotate-90` : ``"
                            aria-hidden="true"
                        />
                    </button>
                    <span v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-0.5"><slot name="actions" :group="item.group" /></span>
                </div>

                <div class="flex min-w-0 flex-col gap-1" :class="indent()">
                    <!-- Who it is to a terminal, what version runs, and its share of the machine: one quiet line. -->
                    <p
                        v-if="item.group.subtitle || sublineOf(item.group).length > 0"
                        class="-mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-2xs text-subtle"
                    >
                        <span v-if="item.group.subtitle" class="inline-flex min-w-0 items-center gap-1">
                            <span class="truncate font-mono">{{ item.group.subtitle }}</span>
                            <CopyButton :text="item.group.subtitle" v-tooltip.top="t(`ui.deviceDetail.copyId`)" />
                        </span>
                        <template v-for="(part, index) in sublineOf(item.group)" :key="part">
                            <span v-if="index > 0 || item.group.subtitle" aria-hidden="true">·</span>
                            <span>{{ part }}</span>
                        </template>
                    </p>
                    <p v-if="item.group.sandbox?.parked" class="text-xs text-warning">{{ t(`ui.deviceDetail.interruptedUpdateHint`) }}</p>

                    <!-- CLOSED: the two facts a card is read for, in words. -->
                    <template v-if="!isOpen(item.group)">
                        <div :class="FACT">
                            <span :class="FACT_LABEL">{{ t(`ui.deviceDetail.files`) }}</span>
                            <span class="flex min-w-0 flex-1 items-baseline gap-x-2 text-xs">
                                <span
                                    v-for="part in filesLine(item.group)"
                                    :key="part.key"
                                    :class="[partClass(part), part.key === `path` ? `min-w-0 truncate` : `shrink-0`]"
                                    v-tooltip.top="part.hint"
                                    >{{ part.text }}</span
                                >
                            </span>
                        </div>
                        <div v-if="portsLine(item.group)" :class="FACT">
                            <span :class="FACT_LABEL">{{ t(`ui.deviceDetail.ports`) }}</span>
                            <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 text-xs">
                                <span v-for="part in portsLine(item.group)" :key="part.key" :class="partClass(part)" v-tooltip.top="part.hint">{{
                                    part.text
                                }}</span>
                            </span>
                        </div>
                    </template>

                    <!--
                        OPEN: THE EVIDENCE, AS ONE TABLE in place of the two lines it expands: a column of names and a
                        column of values, each value's first line as tall as a button, and the verbs for a line at that
                        line's own right edge.
                    -->
                    <dl v-else :id="`${blockId(item.group)}-detail`" class="flex min-w-0 flex-col gap-1.5 pt-0.5">
                        <div v-if="item.group.folder" :class="SECTION">
                            <dt :class="LABEL">{{ t(`ui.deviceDetail.files`) }}</dt>
                            <dd class="flex min-w-0 flex-1 flex-col gap-2">
                                <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                    <!-- Its own width, never less: a path that fits the line beside the verbs stays whole and
                                         the verbs take the next line instead. -->
                                    <div class="flex max-w-full shrink-0 grow flex-col gap-1">
                                        <div :class="LINE" class="gap-1.5">
                                            <!-- Wraps rather than truncates: the end of a path is what identifies it. -->
                                            <span v-if="item.group.folder.localDir" class="break-all font-mono text-xs text-content">{{
                                                item.group.folder.localDir
                                            }}</span>
                                            <span v-else-if="item.group.folder.mode === `mirror`" class="text-xs text-muted">
                                                {{ t(`ui.deviceDetail.noFolderDeviceOnly`) }}
                                            </span>
                                            <span v-else class="text-xs text-muted">{{ t(`ui.deviceDetail.noFolderSynced`) }}</span>
                                            <CopyButton
                                                v-if="item.group.folder.localDir"
                                                :text="item.group.folder.localDir"
                                                v-tooltip.top="t(`ui.deviceDetail.copyPath`)"
                                            />
                                        </div>
                                        <!-- Where the folder stands, only when that is news, and which side of the machine holds it. -->
                                        <div class="flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden">
                                            <StatusBadge
                                                v-if="folderState(item.group.folder) && !restingSync(item.group.folder)"
                                                :variant="folderTone(folderState(item.group.folder))"
                                                size="xs"
                                                :label="folderState(item.group.folder) ?? ``"
                                            />
                                            <!-- Silent when healthy, spoken when not: a stopped backup costs nothing until the sandbox is gone. -->
                                            <StatusBadge
                                                v-if="backupState(item.group.folder) && !restingBackup(item.group.folder)"
                                                :variant="backupTone(backupState(item.group.folder))"
                                                size="xs"
                                                :label="t(`ui.deviceDetail.backup`, { folder: backupState(item.group.folder) })"
                                            />
                                            <slot name="where" :group="item.group" />
                                        </div>
                                    </div>
                                    <!-- What to do about this folder, at its own line's end rather than with the card's verbs, which act on the container. -->
                                    <div v-if="$slots[`folder`]" :class="VERBS"><slot name="folder" :group="item.group" /></div>
                                </div>

                                <!-- Two-way-safe flags conflicts rather than clobbering, and a bare count names no file, cause or
                                     remedy: so it opens into a block of its own, with the verbs that settle it at its foot. -->
                                <div
                                    v-if="conflicts.get(item.group.sandboxId)"
                                    class="flex min-w-0 flex-col gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2.5"
                                >
                                    <p class="flex items-center gap-1.5 text-xs font-medium text-warning">
                                        <Icon name="exclamation-triangle" class="shrink-0" aria-hidden="true" />
                                        {{ t(`ui.deviceDetail.conflicts`, { count: item.group.folder.conflicts ?? 0 }, item.group.folder.conflicts ?? 0) }}
                                    </p>
                                    <p class="text-xs text-muted">{{ conflicts.get(item.group.sandboxId)?.lead }}</p>
                                    <ul class="flex min-w-0 flex-col gap-1">
                                        <li
                                            v-for="row in conflicts.get(item.group.sandboxId)?.rows ?? []"
                                            :key="row.path"
                                            class="flex min-w-0 flex-wrap items-baseline gap-x-2"
                                        >
                                            <span class="break-all font-mono text-2xs text-content">{{ row.path }}</span>
                                            <span v-if="row.note !== ``" class="text-2xs text-subtle">{{ row.note }}</span>
                                        </li>
                                    </ul>
                                    <p
                                        v-if="(conflicts.get(item.group.sandboxId)?.rows.length ?? 0) > 0 && (conflicts.get(item.group.sandboxId)?.more ?? 0) > 0"
                                        class="text-2xs text-subtle"
                                    >
                                        {{ t(`ui.deviceDetail.more`, { more: conflicts.get(item.group.sandboxId)?.more }) }}
                                    </p>
                                    <p v-if="conflicts.get(item.group.sandboxId)?.note" class="text-2xs text-subtle">
                                        {{ conflicts.get(item.group.sandboxId)?.note }}
                                    </p>
                                    <div v-if="$slots[`conflicts`]" class="flex flex-wrap items-center gap-1.5 empty:hidden">
                                        <slot name="conflicts" :group="item.group" />
                                    </div>
                                </div>
                            </dd>
                        </div>

                        <!-- Nothing synced yet: the offer to start, under the same name the folder would have had. -->
                        <div v-else-if="offersSync(item.group)" :class="SECTION">
                            <dt :class="LABEL">{{ t(`ui.deviceDetail.files`) }}</dt>
                            <dd class="min-w-0 flex-1"><slot name="sync" :group="item.group" /></dd>
                        </div>
                        <div v-else :class="SECTION">
                            <dt :class="LABEL">{{ t(`ui.deviceDetail.files`) }}</dt>
                            <dd :class="LINE" class="flex-1 text-xs text-subtle">{{ t(`ui.deviceDetail.notSyncedHere`) }}</dd>
                        </div>

                        <!-- Survives having no ports: an empty list has two causes (nothing served, or mirroring off). -->
                        <div v-if="item.group.ports.length > 0 || mirroringOff(item.group.folder)" :class="SECTION">
                            <dt :class="LABEL">{{ t(`ui.deviceDetail.ports`) }}</dt>
                            <dd class="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <!-- Said as a state, not a fault: somebody threw this switch on purpose. -->
                                <p v-if="mirroringOff(item.group.folder)" :class="LINE" class="min-w-48 flex-1 text-xs text-muted">
                                    {{ t(`ui.deviceDetail.offDeviceIsntPutting`) }}
                                </p>
                                <!-- An address column and a what's-there column; ink marks only a port that didn't reach localhost. -->
                                <div v-else class="grid min-w-64 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4">
                                    <template v-for="port in item.group.ports" :key="`${port.port}:${port.state}`">
                                        <span
                                            :class="[LINE, portInk(port)]"
                                            class="font-mono text-xs"
                                            v-tooltip.top="port.state === `mirrored` ? undefined : port.command"
                                            >{{ port.state === `mirrored` ? t(`ui.deviceDetail.localhost`) : `` }}{{ port.port }}</span
                                        >
                                        <span :class="LINE" class="flex-wrap gap-x-2">
                                            <span
                                                v-if="port.state === `mirrored`"
                                                class="min-w-0 truncate font-mono text-xs text-subtle"
                                                v-tooltip.top="port.command"
                                                >{{ shortCommand(port.command) }}</span
                                            >
                                            <span v-else class="min-w-0 text-xs text-muted">
                                                {{ portNote(port, portHolder(groups, port)) }}
                                                <!-- Goes to the holder's own card, where its Stop lives. -->
                                                <button
                                                    v-if="portHolder(groups, port)"
                                                    type="button"
                                                    class="ml-1 rounded underline decoration-dotted underline-offset-2 transition-colors hover:text-content"
                                                    @click="showHolder(portHolder(groups, port)!)"
                                                >
                                                    {{ t(`ui.deviceDetail.show`) }}
                                                </button>
                                            </span>
                                            <slot name="port" :group="item.group" :port="port" />
                                        </span>
                                    </template>
                                </div>
                                <div v-if="$slots[`ports`]" :class="VERBS"><slot name="ports" :group="item.group" /></div>
                            </dd>
                        </div>
                        <div v-else-if="item.group.folder" :class="SECTION">
                            <dt :class="LABEL">{{ t(`ui.deviceDetail.ports`) }}</dt>
                            <dd class="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <p :class="LINE" class="text-xs text-subtle">{{ t(`ui.deviceDetail.noPorts`) }}</p>
                                <div v-if="$slots[`ports`]" :class="VERBS"><slot name="ports" :group="item.group" /></div>
                            </dd>
                        </div>

                        <!-- The image is the least-read fact, so it is the evidence here rather than a line on the closed card. -->
                        <div v-if="item.group.sandbox" :class="SECTION">
                            <dt :class="LABEL">{{ t(`ui.deviceDetail.image`) }}</dt>
                            <dd :class="LINE" class="flex-1">
                                <span class="truncate font-mono text-xs text-subtle" v-tooltip.top="imageOf(item.group.sandbox)">{{ item.group.sandbox.image }}</span>
                            </dd>
                        </div>
                    </dl>

                    <!-- Outside the disclosure: a verb pressed on a folded card must still show what it's doing. -->
                    <div v-if="$slots[`footer`]" class="empty:hidden">
                        <slot name="footer" :group="item.group" />
                    </div>
                </div>
            </section>
        </template>

        <p v-if="groups.length === 0" class="text-xs text-muted">{{ t(`ui.deviceDetail.deviceIsntSyncingFolder`) }}</p>
    </div>
</template>
