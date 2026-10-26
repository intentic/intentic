<script setup lang="ts">
import { BrandMark, Icon, StatusBadge, type Tip, toneDot, toneFill, toneInk, toneRim } from "@intentic/ui";
import { computed, useId } from "vue";
import { RouterLink } from "vue-router";
import { type BoardEnvironment, boardBody, machineMark, machineSpecs, machineVerdict, type MachineRow, manySided } from "../../../../models/sandbox/devices/deviceRows";
import { deviceRoute } from "../../../../models/sandbox/devices/deviceLinks";
import { lastSeenNote, osTitle } from "../../../../models/sandbox/devices/deviceFacts";
import { environmentWorking, machineWork } from "../runners/deviceWork";
import { useT } from "@intentic/ui/i18n";

// ONE PHYSICAL COMPUTER AS A TILE, read top to bottom in the order a glance asks: WHAT is it (the OS's own mark, the
// name, what it runs on), CAN I USE IT (one verdict, top right, the same place on every tile), and DOES IT WANT ME (its
// warnings, in their own tinted band, and an amber edge round the whole tile). Its environments follow as chips, since
// a live Windows and a sleeping distro have no single word between them.
//
// It used to end on three figures (running, synced, ports) and a line per sandbox. Nobody chose a machine by those
// counts, and the machine's page lists the sandboxes in full, so they went (2026-10-26): what a sandbox has wrong rides
// the warnings band under its name, and the sandbox you are using is a neutral chip beside the machine's name.
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
const specs = computed(() => machineSpecs(machine));
const mark = computed(() => machineMark(machine));
const offline = computed(() => verdict.value.status === `offline`);
// A lone environment is the machine itself, so its full OS string and its doors ride the tile's own line.
const lone = computed(() => (manySided(machine) ? undefined : machine.environments[0]?.device));
const asleepSince = computed(() => (offline.value ? machine.environments.map((side) => lastSeenNote(side.device)).find((note) => note !== undefined) : undefined));
const doing = computed(() => machineWork(machine.key));

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

// "Runs this sandbox", as a chip beside the name rather than a badge on a line of its own; the hover names it.
const selfTip = computed<Tip | undefined>(() =>
    body.value.self === undefined
        ? undefined
        : {
              title: t(`sandbox.deviceBoardCard.yoursHere`),
              tone: `info`,
              rows: [
                  { label: t(`sandbox.deviceBoardCard.sandbox`), value: body.value.self.title },
                  ...(body.value.self.facts.length === 0 ? [] : [{ label: t(`sandbox.deviceBoardCard.here`), value: body.value.self.facts.join(` · `) }]),
              ],
          },
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
                    <span class="flex min-w-0 flex-1 items-center gap-1.5">
                        <span :id="titleId" class="min-w-0 truncate text-base font-semibold leading-6 text-content">{{ machine.label }}</span>
                        <!-- Words, not a mark: a pin read as "pinned" (what it means everywhere else in the editor), and its
                             blue read as one more status beside the verdict. This is identity, not health, so it wears the
                             environment chips' neutral fill and says what it means. -->
                        <span
                            v-if="selfTip"
                            v-tooltip.top="selfTip"
                            class="shrink-0 whitespace-nowrap rounded-md bg-content/5 px-1.5 py-0.5 text-2xs font-medium leading-4 text-muted"
                            >{{ t(`sandbox.deviceBoardCard.yoursHere`) }}</span
                        >
                    </span>
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
                <Icon name="exclamation-circle" class="shrink-0" aria-hidden="true" />
                <span class="min-w-0 break-words leading-4">{{ warning }}</span>
            </li>
        </ul>

        <!-- A filter that found this machine by a sandbox or a port says which, since the tile lists none. -->
        <p v-if="body.matches.length > 0" class="mx-4 mb-3 flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <Icon name="search" class="shrink-0 text-subtle" aria-hidden="true" />
            <span class="min-w-0 truncate">{{ body.matches.join(`, `) }}</span>
        </p>
    </RouterLink>
</template>
