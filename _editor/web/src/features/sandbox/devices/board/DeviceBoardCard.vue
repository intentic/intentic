<script setup lang="ts">
import { BrandMark, Icon, StatusBadge, type Tip, toneDot, toneFill, toneInk, toneRim } from "@intentic/ui";
import { computed, useId } from "vue";
import { RouterLink } from "vue-router";
import { type BoardEnvironment, boardBody, machineFigures, machineMark, machineSpecs, machineVerdict, type MachineRow, manySided } from "../deviceRows";
import { deviceRoute } from "../deviceLinks";
import { lastSeenNote, osTitle } from "../deviceFacts";
import { environmentWorking, machineWork, sandboxesWorking } from "../runners/deviceWork";
import { useT } from "@intentic/ui/i18n";

// ONE PHYSICAL COMPUTER AS A TILE, read top to bottom in the order a glance asks: WHAT is it (the OS's own mark, the
// name, what it runs on), CAN I USE IT (one verdict, top right, the same place on every tile), DOES IT WANT ME (its
// warnings, in their own tinted band, and an amber edge round the whole tile), and WHAT IS IT DOING (three figures that
// line up across the board, then the sandboxes themselves). It used to be a stack of rows inside rows, one per side and
// one per sandbox, every one led by the same monitor glyph, so the machine and the things on it read at one weight.
//
// The whole surface is one link into the machine's page; nothing on it is a control. Work in flight turns on it the
// way it does on the page (deviceWork.ts), since the page that started it is usually not on screen any more.

const t = useT();
const titleId = useId();

const { machine, needle, ownSlug, readAt } = defineProps<{
    machine: MachineRow;
    /** The board's filter, lower-cased; every matching sandbox is drawn while it is set. */
    needle: string;
    ownSlug: string | undefined;
    /** When this reading landed; the machine is judged as of then, not as of now. */
    readAt: number;
}>();

const body = computed(() => boardBody(machine, needle, ownSlug, readAt));
const verdict = computed(() => machineVerdict(machine, readAt));
const figures = computed(() => machineFigures(machine));
const specs = computed(() => machineSpecs(machine));
const mark = computed(() => machineMark(machine));
const offline = computed(() => verdict.value.status === `offline`);
// A lone environment is the machine itself, so its full OS string and its doors ride the tile's own line.
const lone = computed(() => (manySided(machine) ? undefined : machine.environments[0]?.device));
const asleepSince = computed(() => (offline.value ? machine.environments.map((side) => lastSeenNote(side.device)).find((note) => note !== undefined) : undefined));
const doing = computed(() => machineWork(machine.key));
const turning = computed(() => sandboxesWorking(machine.key));

// The OS in full and how this sandbox reaches the machine: the facts nobody scans for, one hover from the line.
const specsTip = computed<Tip | undefined>(() => {
    const rows = [
        { label: t(`sandbox.words.os`), value: lone.value === undefined ? `` : (osTitle(lone.value) ?? ``) },
        { label: t(`sandbox.deviceBoardCard.reachedThrough`), value: body.value.doors.join(`, `) },
    ].filter((row) => row.value !== ``);
    return rows.length === 0 ? undefined : { title: machine.label, rows };
});

const sideTip = (side: BoardEnvironment): Tip => ({
    title: side.label,
    tone: side.tone === `neutral` ? undefined : side.tone === `success` ? `success` : `warning`,
    rows: [
        { label: t(`sandbox.deviceBoardCard.state`), value: side.lastSeen === undefined ? side.state : `${side.state} · ${side.lastSeen}` },
        ...(side.doors.length === 0 ? [] : [{ label: t(`sandbox.deviceBoardCard.reachedThrough`), value: side.doors.join(`, `) }]),
    ],
});

const runningTip = computed(() =>
    figures.value.hosted === undefined
        ? t(`sandbox.deviceBoardCard.notListed`)
        : t(`sandbox.deviceBoardCard.runningTip`, { running: figures.value.running, hosted: figures.value.hosted }),
);
</script>

<template>
    <RouterLink
        :to="deviceRoute(machine.key)"
        :aria-labelledby="titleId"
        class="ui-row-select flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm"
        :class="verdict.status === `attention` ? toneRim(`warning`) : `border-transparent`"
    >
        <!-- WHAT IT IS, and the one verdict, in the same corner on every tile so a column of them scans as a column. -->
        <div class="flex items-start gap-3 px-4 pb-3 pt-4">
            <BrandMark :size="40" :name="machine.label" :icon="mark.icon" :tint="mark.tint" :idle="offline" />
            <!-- The hover rides the whole column, not the facts line: a machine that never described itself has no line,
                 and still has to answer how this sandbox reaches it. -->
            <div v-tooltip.top="specsTip" class="flex min-w-0 flex-1 flex-col gap-0.5">
                <div class="flex min-w-0 items-center gap-2">
                    <span :id="titleId" class="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-content">{{ machine.label }}</span>
                    <StatusBadge :variant="verdict.variant" size="xs" :dot="true" :label="verdict.word" class="shrink-0" />
                </div>
                <span v-if="specs.length > 0 || asleepSince" class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted">
                    <span v-if="specs.length > 0" class="min-w-0 truncate">{{ specs.join(` · `) }}</span>
                    <!-- Noise on a live machine, the most useful fact on one that isn't. -->
                    <span v-if="asleepSince" class="shrink-0 text-subtle">{{ asleepSince }}</span>
                </span>
            </div>
        </div>

        <!-- What is moving on this machine: the one fact here that is about to change. -->
        <p v-if="doing" :class="toneInk(`info`, `mx-4 mb-3 flex min-w-0 items-center gap-1.5 text-xs`)">
            <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />
            <span class="min-w-0 truncate">{{ doing }}</span>
        </p>

        <!-- Each side of a many-sided PC, as a chip under its own OS's mark with its own state's dot: a live Windows and a
             sleeping distro have no single word between them, and the verdict above is about the PC. -->
        <ul v-if="body.environments.length > 0" class="flex min-w-0 flex-wrap gap-1.5 px-4 pb-3">
            <li
                v-for="side in body.environments"
                :key="side.key"
                v-tooltip.top="sideTip(side)"
                class="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-content/5 py-1 pl-1.5 pr-2 text-2xs text-content"
            >
                <Icon v-if="environmentWorking(side.key)" name="spinner" spin class="shrink-0 text-xs text-muted" aria-hidden="true" />
                <BrandMark v-else :size="16" :name="side.label" :icon="side.mark.icon" :tint="side.mark.tint" :plain="true" :idle="side.tone === `neutral`" />
                <span class="min-w-0 truncate" :class="side.tone === `neutral` ? `text-muted` : ``">{{ side.label }}</span>
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="toneDot(side.tone)" role="img" :aria-label="side.state"></span>
            </li>
        </ul>

        <!-- DOES IT WANT ME: in a band of its own, so it is never read as one more fact about a sandbox. -->
        <ul
            v-if="body.warnings.length > 0"
            :class="toneFill(`warning`, `strong`, toneInk(`warning`), `mx-4 mb-3 flex flex-col gap-1 rounded-lg px-3 py-2 text-2xs`)"
        >
            <li v-for="warning in body.warnings" :key="warning" class="flex min-w-0 items-start gap-2">
                <Icon name="exclamation-circle" class="mt-px shrink-0" aria-hidden="true" />
                <span class="min-w-0 break-words leading-4">{{ warning }}</span>
            </li>
        </ul>

        <!-- The figures, in the same three columns on every tile, so a board compares machines by reading across. A
             machine asleep keeps its last numbers, quieter, since they are a memory rather than a reading. -->
        <dl class="grid grid-cols-3 border-t border-line-subtle" :class="offline ? `opacity-60` : ``">
            <div v-tooltip.top="runningTip" class="flex flex-col-reverse gap-0.5 px-4 py-2.5">
                <dt class="text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.running`) }}</dt>
                <dd class="text-lg font-semibold leading-6 tabular-nums text-content">
                    <template v-if="figures.hosted === undefined">—</template>
                    <template v-else>
                        {{ figures.running }}<span v-if="figures.hosted !== figures.running" class="text-sm font-normal text-subtle">/{{ figures.hosted }}</span>
                    </template>
                </dd>
            </div>
            <div v-tooltip.top="t(`sandbox.deviceBoardCard.syncedTip`)" class="flex flex-col-reverse gap-0.5 border-l border-line-subtle px-4 py-2.5">
                <dt class="text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.synced`) }}</dt>
                <dd class="text-lg font-semibold leading-6 tabular-nums" :class="figures.synced === 0 ? `text-subtle` : `text-content`">{{ figures.synced }}</dd>
            </div>
            <div v-tooltip.top="t(`sandbox.deviceBoardCard.portsTip`)" class="flex flex-col-reverse gap-0.5 border-l border-line-subtle px-4 py-2.5">
                <dt class="text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.ports`) }}</dt>
                <dd class="text-lg font-semibold leading-6 tabular-nums" :class="figures.ports === 0 ? `text-subtle` : `text-content`">{{ figures.ports }}</dd>
            </div>
        </dl>

        <!-- What runs here, one line per sandbox, capped; a full row each would make the tile taller than the machine. -->
        <ul
            v-if="body.lines.length > 0 || body.more > 0"
            class="flex flex-col gap-1.5 border-t border-line-subtle px-4 py-3"
            :class="offline ? `opacity-60` : ``"
        >
            <li v-for="line in body.lines" :key="line.sandboxId" class="flex min-w-0 items-center gap-2.5">
                <span class="flex w-3 shrink-0 justify-center">
                    <!-- Turns while something is done to this sandbox, as its row does on the page. -->
                    <Icon v-if="turning.includes(line.sandboxId)" name="spinner" spin class="text-2xs text-muted" aria-hidden="true" />
                    <span
                        v-else-if="line.running !== undefined"
                        class="h-2 w-2 rounded-full"
                        :class="toneDot(line.running ? `success` : `neutral`)"
                        role="img"
                        :aria-label="line.running ? t(`sandbox.deviceBoardCard.running`) : t(`sandbox.deviceBoardCard.stopped`)"
                    ></span>
                    <!-- Synced or mirrored here, running somewhere else: a hollow ring, present but not on this engine. -->
                    <span
                        v-else
                        class="h-2 w-2 rounded-full border border-content/30"
                        role="img"
                        :aria-label="t(`sandbox.deviceBoardCard.notRunningHere`)"
                    ></span>
                </span>
                <span class="flex min-w-0 flex-1 items-center gap-2">
                    <span class="min-w-0 truncate text-xs" :class="line.running === true ? `text-content` : `text-muted`">{{ line.title }}</span>
                    <StatusBadge v-if="line.self" variant="info" size="xs" :label="t(`sandbox.words.oneYoureUsing`)" class="shrink-0" />
                </span>
                <!-- Facts as a row's meta: counted and uncoloured. A warning keeps its ink: it is the reason to open this machine. -->
                <span v-if="line.warnings.length > 0" class="min-w-0 max-w-[55%] truncate text-2xs text-warning" v-tooltip.top="line.warnings.join(` · `)">
                    {{ line.warnings[0] }}
                </span>
                <span v-else-if="line.facts.length > 0" class="shrink-0 text-2xs tabular-nums text-subtle">{{ line.facts.join(` · `) }}</span>
            </li>
            <!-- Counted against what the machine reported, so a capped list never reads as the whole of it. -->
            <li v-if="body.more > 0" class="pl-5 text-2xs text-subtle">{{ t(`sandbox.deviceBoardCard.more`, { more: body.more }) }}</li>
        </ul>
        <!-- A machine that holds nothing says so, rather than ending on three noughts that read as a reading gone wrong. -->
        <p v-else-if="needle === ``" class="border-t border-line-subtle px-4 py-3 text-xs text-subtle">
            {{ t(`sandbox.deviceBoardCard.holdsNothing`) }}
        </p>
    </RouterLink>
</template>
