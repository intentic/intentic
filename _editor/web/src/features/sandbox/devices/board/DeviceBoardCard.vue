<script setup lang="ts">
import { BrandMark, Icon, SandboxLogo, StatusBadge, type Tip, toneDot, toneFill, toneInk, toneRim } from "@intentic/ui";
import { computed, useId } from "vue";
import { RouterLink } from "vue-router";
import { type BoardEnvironment, boardBody, machineMark, machineSpecs, machineVerdict, type MachineRow, manySided } from "../../../../models/sandbox/devices/deviceRows";
import { deviceRoute } from "../../../../models/sandbox/devices/deviceLinks";
import { lastSeenNote, osTitle } from "../../../../models/sandbox/devices/deviceFacts";
import { environmentWorking, machineWork } from "../runners/deviceWork";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useT } from "@intentic/ui/i18n";

// ONE PHYSICAL COMPUTER AS A TILE, read top to bottom in the order a glance asks: WHAT is it (the OS's own mark, the
// name, what it runs on), CAN I USE IT (a presence dot on the mark), and DOES IT WANT ME (words in the top-right corner,
// its warnings in their own tinted band, and an amber edge round the whole tile). Its environments follow as chips,
// since a live Windows and a sleeping distro have no single word between them. They and the band run the tile's full
// width from the mark's left edge: hung off the name instead, two chips no longer fit one line of a two-column board.
//
// It used to end on three figures (running, synced, ports) and a line per sandbox. Nobody chose a machine by those
// counts, and the machine's page lists the sandboxes in full, so they went (2026-10-26): what a sandbox has wrong rides
// the warnings band under its name.
//
// Only what is out of the ordinary takes words (2026-11-27). Most machines are live most of the time, so "live" was a
// green pill on nearly every tile and the one tile that wanted the owner did not stand out: answering is now a dot on
// the mark (an avatar's presence dot), asleep greys the mark and leads the facts line with when it was last seen, and
// the corner holds words only for "needs attention". The sandbox you are using went from a "Runs this sandbox" chip to
// that sandbox's own logo beside the name (a pin read as "pinned", blue read as one more status), and its tile sorts
// first on the board.
//
// The whole surface is one link into the machine's page; nothing on it is a control. Work in flight turns on it the
// way it does on the page (deviceWork.ts), since the page that started it is usually not on screen any more.

const t = useT();
const titleId = useId();
const stateId = useId();
const { active: ownSandbox } = useSandbox();

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
// What the machine IS in one line: on an asleep one, when it was last seen leads, since that is the fact worth reading
// there and noise on a live one. Two lines before it is cut, since a tile's row shares the tallest tile's height anyway.
const factsLine = computed(() => [asleepSince.value, ...specs.value].filter((part) => part !== undefined).join(` · `));
// The words a screen reader gets for what the tile shows without them: the dot, the corner, the logo.
const stateWords = computed(() =>
    [
        verdict.value.presence.word,
        verdict.value.status === `attention` ? verdict.value.word : undefined,
        body.value.self === undefined ? undefined : t(`sandbox.deviceBoardCard.yoursHere`),
    ]
        .filter((part) => part !== undefined)
        .join(`, `),
);
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

// "Runs this sandbox", as that sandbox's own logo beside the name; the hover says it in words.
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
        :aria-describedby="stateId"
        class="ui-row-select flex h-full min-w-0 flex-col gap-3 overflow-hidden rounded-xl border bg-card px-4 py-3.5 shadow-sm"
        :class="verdict.status === `attention` ? toneRim(`warning`) : `border-transparent`"
    >
        <div class="flex min-w-0 items-start gap-3">
            <!-- Whether it answers, as a dot on the mark's corner: the default state takes no word. A ring in the card's own
                 colour cuts it out of the mark, as an avatar's presence dot is. -->
            <span v-tooltip.top="verdict.presence.word" class="relative shrink-0">
                <BrandMark :size="40" :name="machine.label" :icon="mark.icon" :tint="mark.tint" :idle="offline" />
                <span
                    :class="
                        toneDot(
                            verdict.presence.tone,
                            `absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card`,
                            verdict.presence.returning ? `motion-safe:animate-pulse` : ``,
                        )
                    "
                    aria-hidden="true"
                ></span>
            </span>

            <!-- WHAT IT IS. The hover rides the whole name-and-facts block, not the facts line: a machine that never
                 described itself has no line, and still has to answer how this sandbox reaches it. -->
            <div v-tooltip.top="specsTip" class="flex min-w-0 flex-1 flex-col gap-0.5">
                <div class="flex min-w-0 items-center gap-2">
                    <span class="flex min-w-0 flex-1 items-center gap-1.5">
                        <span
                            :id="titleId"
                            class="min-w-0 truncate text-base font-semibold leading-6"
                            :class="offline ? `text-muted` : `text-content`"
                            >{{ machine.label }}</span
                        >
                        <!-- This sandbox's own logo: identity, not health, so it wears no tone; the hover says it in words. -->
                        <span
                            v-if="selfTip"
                            v-tooltip.top="selfTip"
                            class="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-content/5"
                        >
                            <SandboxLogo :image="ownSandbox?.image ?? null" :name="ownSandbox?.name ?? body.self?.title" :size="14" />
                        </span>
                    </span>
                    <!-- Words only when it wants the owner: the one tile worth reading stands out in a column of quiet corners. -->
                    <StatusBadge v-if="verdict.status === `attention`" :variant="verdict.variant" size="xs" :label="verdict.word" class="shrink-0" />
                </div>
                <span v-if="factsLine !== ``" class="line-clamp-2 break-words text-xs text-muted">{{ factsLine }}</span>
                <span :id="stateId" class="sr-only">{{ stateWords }}</span>
            </div>
        </div>

        <!-- What is moving on this machine: the one fact here that is about to change. -->
        <p v-if="doing" :class="toneInk(`info`, `flex min-w-0 items-center gap-1.5 text-xs`)">
            <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />
            <span class="min-w-0 truncate">{{ doing }}</span>
        </p>

        <!-- Each side of a many-sided PC, as a chip under its own OS's mark with its own state's dot: a live Windows and a
             sleeping distro have no single word between them, and the dot on the mark above is about the PC. Mark, word
             and dot share one 16px line box, so all three centre on the same axis. -->
        <ul v-if="body.environments.length > 0" class="flex min-w-0 flex-wrap gap-1.5">
            <li
                v-for="side in body.environments"
                :key="side.key"
                v-tooltip.top="sideTip(side)"
                class="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md bg-content/5 pl-1.5 pr-2 text-2xs leading-4 text-content"
            >
                <span class="inline-flex size-4 shrink-0 items-center justify-center">
                    <Icon v-if="environmentWorking(side.key)" name="spinner" spin class="text-xs text-muted" aria-hidden="true" />
                    <BrandMark
                        v-else
                        :size="16"
                        :name="side.label"
                        :icon="side.mark.icon"
                        :tint="side.mark.tint"
                        :plain="true"
                        :idle="side.tone === `neutral`"
                    />
                </span>
                <span class="min-w-0 truncate" :class="side.tone === `neutral` ? `text-muted` : ``">{{ side.label }}</span>
                <span class="size-1.5 shrink-0 rounded-full" :class="toneDot(side.tone)" role="img" :aria-label="side.state"></span>
            </li>
        </ul>

        <!-- DOES IT WANT ME: in a band of its own, so it is never read as one more fact about a sandbox. Every amber dot
             above has its line here (deviceFacts' sideWarnings). -->
        <ul
            v-if="body.warnings.length > 0"
            :class="toneFill(`warning`, `strong`, toneInk(`warning`), `flex flex-col gap-1 rounded-lg px-2.5 py-2 text-2xs`)"
        >
            <li v-for="warning in body.warnings" :key="warning" class="flex min-w-0 items-start gap-1.5 leading-4">
                <span class="inline-flex h-4 shrink-0 items-center"><Icon name="exclamation-circle" aria-hidden="true" /></span>
                <span class="min-w-0 break-words">{{ warning }}</span>
            </li>
        </ul>

        <!-- A filter that found this machine by a sandbox or a port says which, since the tile lists none. -->
        <p v-if="body.matches.length > 0" class="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <Icon name="search" class="shrink-0 text-subtle" aria-hidden="true" />
            <span class="min-w-0 truncate">{{ body.matches.join(`, `) }}</span>
        </p>
    </RouterLink>
</template>
