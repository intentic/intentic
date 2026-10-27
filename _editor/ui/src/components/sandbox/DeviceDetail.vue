<!-- A device's synced folders, ports and containers. What its agent is doing is the masthead's (<DeviceEnvironmentRow>),
     stated once above this list rather than a second time riding it.

     ONE CARD, ONE READING, ONE MENU. A card used to be a disclosure: a chevron beside the ⋯, a closed summary and an open
     table that said the same facts again in another layout, with a chip for every state and a button at the end of
     each line (Pause syncing, Unpair in red, Stop mirroring, Mirror it). Now it is read as it stands: the name and where
     it stands in a word, one quiet line of version and share, then its files and its ports. Everything that changes
     what this machine does for the sandbox lives in the card's one ⋯ (the caller's `SandboxVerbs`), and the only
     controls left on a line are the fixes for a problem that line states: a contested port, a conflicted folder. -->
<script setup lang="ts">
import { Comment, computed, Fragment, isVNode, onBeforeUnmount, ref, Text, useId, type VNode } from "vue";
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
    isUntitled,
    type DeviceFolderRow,
    type DevicePortRow,
    type DeviceSandboxGroup,
    type DeviceSandboxRow,
    keeperLine,
    mirroringOff,
    portHolder,
    portNote,
    portsLine,
    sandboxGroups,
} from "./deviceDetail.js";
import type { StatusVariant } from "../feedback/statusBadge.js";
import { useT } from "../../i18n/index.js";
import { toneTint } from "../../lib/tone.js";
import type { Tip } from "../../lib/tooltip.js";

const t = useT();

const {
    pairings = [],
    ports = [],
    sandboxes = [],
    busy = [],
    selected = [],
    leading = [],
} = defineProps<{
    pairings?: readonly DeviceFolderRow[];
    ports?: readonly DevicePortRow[];
    // Containers on the machine, when known (desktop's own `docker ps`, or a `host`-capability daemon read);
    // absent, every row is just a folder and its ports.
    sandboxes?: readonly DeviceSandboxRow[];
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
    // Which side of a many-sided machine holds the folder, said among the folder's own facts under its path: the
    // path alone says it, but not in words.
    where?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // The verbs that settle this folder's conflicts, at the foot of the block that explains them: they answer that
    // block, not the folder as a whole.
    conflicts?: (props: { group: DeviceSandboxGroup }) => VNode[];
    // A caller's own fact line about the sandbox (its network fence), with the classes the card's own lines use.
    fact?: (props: { group: DeviceSandboxGroup; row: string; label: string }) => VNode[];
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

// A card's facts as one table: a name column wide enough for "Files", and the value beside it. The name column is the
// header's indent, so every line starts under the sandbox's name.
const FACT = `flex min-w-0 items-baseline gap-3`;
const FACT_LABEL = `w-10 shrink-0 text-2xs text-subtle`;

// Everything under the header starts under the NAME: past the tick box when there is one, then the picture.
const indent = (): string => (slots.select === undefined ? `pl-10.5` : `pl-17.5`);

const TONE = { content: `text-content`, muted: `text-muted`, subtle: `text-subtle`, warning: `text-warning` } as const satisfies Record<CardTone, string>;
// The code face runs a size larger than the sans beside it, so a path or an address is set a step down to sit level.
const partClass = (part: CardPart): string[] => [TONE[part.tone], part.mono === true ? `font-mono text-2xs` : ``];

// Where the sandbox stands, as a dot and a word in the line's own ink rather than a chip: a list of cards each wearing
// two or three pills read as a wall of tags. Only a state worth acting on takes its colour into the word.
const DOT = {
    success: `bg-success`,
    warning: `bg-warning`,
    danger: `bg-danger`,
    info: `bg-info`,
    neutral: `bg-subtle`,
    primary: `bg-primary`,
} as const satisfies Record<StatusVariant, string>;
const WORD = {
    success: `text-muted`,
    warning: `text-warning`,
    danger: `text-danger`,
    info: `text-muted`,
    neutral: `text-subtle`,
    primary: `text-muted`,
} as const satisfies Record<StatusVariant, string>;

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

// The name's hover: the least-read facts, which used to be a line of their own each (the image; which side keeps it).
const idTip = (group: DeviceSandboxGroup): Tip | undefined => {
    const sandbox = group.sandbox;
    if (sandbox === undefined) {
        return undefined;
    }
    const rows = [{ label: t(`ui.deviceDetail.image`), value: sandbox.image }];
    const keeper = sandbox.adoptedFrom === undefined ? keeperLine(sandbox) : undefined;
    return keeper === undefined ? { title: t(`ui.deviceDetail.container`), rows } : { title: t(`ui.deviceDetail.container`), rows, note: keeper };
};

// The ports that reached localhost, as the line names them; a port that did not is a line of its own below, with its fix.
const reachedParts = (group: DeviceSandboxGroup): CardPart[] =>
    (portsLine(group) ?? []).filter((part) => part.key !== `taken` && part.key !== `busy` && part.key !== `alone`);
const missedPorts = (group: DeviceSandboxGroup): DevicePortRow[] =>
    mirroringOff(group.folder) ? [] : [...new Map(group.ports.filter((port) => port.state !== `mirrored`).map((port) => [port.port, port])).values()];
const portsShown = (group: DeviceSandboxGroup): boolean => reachedParts(group).length > 0 || missedPorts(group).length > 0;

// Every row's conflict block, derived once and keyed by sandbox id rather than recomputed per template read.
const conflicts = computed(() => new Map(groups.value.map((group) => [group.sandboxId, folderConflicts(group.folder)])));

// Read at render: a machine's report is re-read on the page's own poll, and a probation that ended drops off its next one.
// A sandbox whose files this computer does not keep, and cannot start keeping from here, says so last on this line.
const sublineOf = (group: DeviceSandboxGroup): string[] => [
    ...cardSubline(group, Date.now()),
    ...(group.folder === undefined && !offersSync(group) ? [t(`ui.deviceDetail.filesNotSynced`)] : []),
];

// A sandbox nothing named prints its raw id as the id it is, under a title that says it has none (`isUntitled`).
const untitled = isUntitled;
const exactId = (group: DeviceSandboxGroup): string | undefined => group.subtitle ?? (untitled(group) ? group.title : undefined);

// The list as it is read (see `cardOrder`): every sandbox that is doing something here, then, apart, the idle ones.
const bands = computed(() => cardOrder(groups.value, leading));

// The idle band folds away under a header that counts it, so leftovers stop being half of a busy machine's list. It
// opens by itself on a machine with nothing else to show, and whenever one of its rows is named by the caller or
// ticked, so a selection is never hidden.
const idleChosen = ref<boolean>();
const idleShown = computed(
    () =>
        idleChosen.value ??
        (bands.value.active.length === 0 || bands.value.idle.some((group) => leading.includes(group.sandboxId) || selected.includes(group.sandboxId))),
);
// One list to draw, the idle band's header in it as an item of its own, so a card is written once.
type Item = { readonly kind: `card`; readonly group: DeviceSandboxGroup } | { readonly kind: `idle`; readonly count: number };
const items = computed<Item[]>(() => [
    ...bands.value.active.map((group): Item => ({ kind: `card`, group })),
    ...(bands.value.idle.length === 0 ? [] : [{ kind: `idle`, count: bands.value.idle.length } satisfies Item]),
    ...(idleShown.value ? bands.value.idle.map((group): Item => ({ kind: `card`, group })) : []),
]);
const itemKey = (item: Item): string => (item.kind === `card` ? item.group.sandboxId : `:idle`);

// Backup is silent when healthy, since another quiet grey word here would be noise; a stopped one is said on the line.
const backupNews = (folder: DeviceFolderRow | undefined): string | undefined =>
    folder === undefined || backupState(folder) === undefined || backupTone(backupState(folder)) === `success`
        ? undefined
        : t(`ui.deviceDetail.backup`, { folder: backupState(folder) });

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
    document.getElementById(id)?.scrollIntoView({ behavior: `smooth`, block: `center` });
    clearTimeout(flashTimer);
    flashing.value = id;
    flashTimer = setTimeout(() => (flashing.value = undefined), FLASH_MS);
};
onBeforeUnmount(() => clearTimeout(flashTimer));
</script>

<template>
    <div class="flex flex-col gap-3">
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

            <!-- ONE CARD PER SANDBOX: who it is and where it stands, then its files and its ports, in words. -->
            <section
                v-else
                :id="blockId(item.group)"
                class="ui-row-select flex min-w-0 flex-col gap-2 rounded-xl bg-card px-4 py-3 shadow-sm transition-colors duration-500"
                :class="[
                    selected.includes(item.group.sandboxId) ? `ui-row-select-on` : undefined,
                    flashing === blockId(item.group) ? toneTint(`warning`) : undefined,
                ]"
                :aria-label="item.group.title"
            >
                <!-- The header: tick box, picture, name and standing, then the caller's one menu. -->
                <div class="flex min-w-0 items-center gap-x-2.5">
                    <span v-if="$slots[`select`]" class="flex w-5 shrink-0 items-center justify-center"><slot name="select" :group="item.group" /></span>
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-content/5">
                        <slot name="lead" :group="item.group"><SandboxLogo :name="untitled(item.group) ? undefined : item.group.title" :size="18" /></slot>
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col">
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
                            <!-- A sandbox nothing named says so, and keeps its id on the line below like any other card. -->
                            <h3
                                class="min-w-0 truncate text-sm font-medium"
                                :class="item.group.sandbox === undefined || untitled(item.group) ? `text-muted` : `text-content`"
                                v-tooltip.top="idTip(item.group)"
                            >
                                {{ untitled(item.group) ? t(`ui.deviceDetail.unnamed`) : item.group.title }}
                            </h3>
                            <span
                                class="inline-flex shrink-0 items-center gap-1.5 text-2xs"
                                :class="WORD[cardStatus(item.group, busy.includes(item.group.sandboxId)).variant]"
                                v-tooltip.top="cardStatus(item.group, busy.includes(item.group.sandboxId)).hint"
                            >
                                <Icon v-if="busy.includes(item.group.sandboxId)" name="spinner" spin class="text-2xs text-info" aria-hidden="true" />
                                <span
                                    v-else
                                    class="size-1.5 shrink-0 rounded-full"
                                    :class="DOT[cardStatus(item.group, busy.includes(item.group.sandboxId)).variant]"
                                    aria-hidden="true"
                                />
                                {{ cardStatus(item.group, busy.includes(item.group.sandboxId)).label }}
                            </span>
                            <span v-if="item.group.sandbox?.tunnelRunning === false" class="shrink-0 text-2xs text-warning">{{ t(`ui.deviceDetail.tunnelOff`) }}</span>
                            <slot name="badges" :group="item.group" />
                        </div>
                        <!-- Who it is to a terminal, what version runs, and its share of the machine: one quiet line. The
                             name's hover holds the rest (the image, which side keeps it). -->
                        <p
                            v-if="exactId(item.group) || sublineOf(item.group).length > 0"
                            class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-2xs text-subtle"
                        >
                            <span v-if="exactId(item.group)" class="inline-flex min-w-0 items-center gap-1">
                                <span class="truncate font-mono">{{ exactId(item.group) }}</span>
                                <CopyButton :text="exactId(item.group) ?? ``" v-tooltip.top="t(`ui.deviceDetail.copyId`)" />
                            </span>
                            <template v-for="(part, index) in sublineOf(item.group)" :key="part">
                                <span v-if="index > 0 || exactId(item.group)" aria-hidden="true">·</span>
                                <span>{{ part }}</span>
                            </template>
                        </p>
                    </div>
                    <span v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-0.5 self-start"><slot name="actions" :group="item.group" /></span>
                </div>

                <!-- Gone when every line in it is (a card with no files, ports or run to show), so the card's gap does not
                     hang an empty band under its name. -->
                <div class="flex min-w-0 flex-col gap-1.5 [&:not(:has(>:not(:empty)))]:hidden" :class="indent()">
                    <p v-if="item.group.sandbox?.parked" class="text-xs text-warning">{{ t(`ui.deviceDetail.interruptedUpdateHint`) }}</p>

                    <!-- FILES: where this computer keeps them, and only what is news about them beside the path. None kept
                         here is said on the line under the name, not given a line of its own to say it. -->
                    <div v-if="item.group.folder" :class="FACT">
                        <span :class="FACT_LABEL">{{ t(`ui.deviceDetail.files`) }}</span>
                        <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                            <!-- Which side of a many-sided machine holds the folder, as its mark ahead of the path. -->
                            <slot v-if="item.group.folder" name="where" :group="item.group" />
                            <template v-for="part in filesLine(item.group)" :key="part.key">
                                <span v-if="part.key === `path`" class="inline-flex min-w-0 items-center gap-1">
                                    <!-- Wraps rather than truncates: the end of a path is what identifies it. -->
                                    <span class="break-all" :class="partClass(part)">{{ part.text }}</span>
                                    <CopyButton v-if="part.mono" :text="part.text" v-tooltip.top="t(`ui.deviceDetail.copyPath`)" />
                                </span>
                                <span v-else class="shrink-0" :class="partClass(part)" v-tooltip.top="part.hint">{{ part.text }}</span>
                            </template>
                            <span v-if="backupNews(item.group.folder)" class="shrink-0 text-warning">{{ backupNews(item.group.folder) }}</span>
                        </span>
                    </div>
                    <!-- Nothing synced yet, and this sandbox can start it here: the offer stands where the folder would. -->
                    <div v-else-if="offersSync(item.group)" :class="FACT">
                        <span :class="FACT_LABEL">{{ t(`ui.deviceDetail.files`) }}</span>
                        <div class="min-w-0 flex-1"><slot name="sync" :group="item.group" /></div>
                    </div>

                    <!-- Two-way-safe flags conflicts rather than clobbering, and a bare count names no file, cause or
                         remedy: so it opens into a block of its own, with the verbs that settle it at its foot. -->
                    <div
                        v-if="item.group.folder && conflicts.get(item.group.sandboxId)"
                        :class="toneTint(`warning`, `soft`, `flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5`)"
                    >
                        <p class="text-xs text-muted">{{ conflicts.get(item.group.sandboxId)?.lead }}</p>
                        <ul class="flex min-w-0 flex-col gap-1">
                            <li v-for="row in conflicts.get(item.group.sandboxId)?.rows ?? []" :key="row.path" class="flex min-w-0 flex-wrap items-baseline gap-x-2">
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
                        <p v-if="conflicts.get(item.group.sandboxId)?.note" class="text-2xs text-subtle">{{ conflicts.get(item.group.sandboxId)?.note }}</p>
                        <div v-if="$slots[`conflicts`]" class="flex flex-wrap items-center gap-1.5 empty:hidden">
                            <slot name="conflicts" :group="item.group" />
                        </div>
                    </div>

                    <!-- PORTS: what reached localhost on one line; a port that didn't is a line of its own, saying why,
                         with the one fix for it at its end. -->
                    <div v-if="portsShown(item.group)" :class="FACT">
                        <span :class="FACT_LABEL">{{ t(`ui.deviceDetail.ports`) }}</span>
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                            <span v-if="reachedParts(item.group).length > 0" class="flex min-w-0 flex-wrap items-baseline gap-x-3 text-xs">
                                <span v-for="part in reachedParts(item.group)" :key="part.key" :class="partClass(part)" v-tooltip.top="part.hint">{{ part.text }}</span>
                            </span>
                            <span v-for="port in missedPorts(item.group)" :key="port.port" class="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                                <span class="font-mono" :class="port.state === `ignored` ? `text-subtle` : `text-warning`" v-tooltip.top="port.command">{{
                                    port.port
                                }}</span>
                                <span class="min-w-0 text-muted">{{ portNote(port, portHolder(groups, port)) }}</span>
                                <!-- Goes to the holder's own card, where its Stop lives. -->
                                <button
                                    v-if="portHolder(groups, port)"
                                    type="button"
                                    class="rounded text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-content"
                                    @click="showHolder(portHolder(groups, port)!)"
                                >
                                    {{ t(`ui.deviceDetail.show`) }}
                                </button>
                                <slot name="port" :group="item.group" :port="port" />
                            </span>
                        </div>
                    </div>

                    <!-- A caller's own fact about the sandbox (its network fence), drawn in the same columns as the lines above. -->
                    <slot name="fact" :group="item.group" :row="FACT" :label="FACT_LABEL" />

                    <!-- Outside the facts: a verb pressed on a card must show what it's doing under it. -->
                    <div v-if="$slots[`footer`]" class="empty:hidden">
                        <slot name="footer" :group="item.group" />
                    </div>
                </div>
            </section>
        </template>

        <p v-if="groups.length === 0" class="text-xs text-muted">{{ t(`ui.deviceDetail.deviceIsntSyncingFolder`) }}</p>
    </div>
</template>
