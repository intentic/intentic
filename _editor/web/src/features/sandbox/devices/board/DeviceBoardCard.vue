<script setup lang="ts">
import { Icon, Row, RowGroup, RowNote, StatusBadge } from "@intentic/ui";
import { computed, useId } from "vue";
import { RouterLink } from "vue-router";
import { boardBody, deviceState, deviceTone, type MachineRow, manySided } from "../deviceRows";
import { deviceRoute } from "../deviceLinks";
import { lastSeenNote, osLabel, osTitle } from "../deviceFacts";
import { environmentWorking, machineWork, sandboxesWorking } from "../runners/deviceWork";
import { useT } from "@intentic/ui/i18n";

// One physical computer: a surface of its own, drawn in the rows every sandbox list uses, so a connected PC's lines
// never run into the next machine's. The machine leads, then one row per environment with its own state, then
// what runs here. The whole surface is one link into the machine's page; nothing on it is a control.
// Work in flight on the machine turns on it the way it does on the page (deviceWork.ts): the card names what is moving,
// the environment it moves turns its glyph, and so does the line of every sandbox it acts on. The page that started it is
// usually not on screen any more, which is the whole reason this card has to say so.

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
// A lone environment is the machine itself, so its facts and state ride the machine's row.
const lone = computed(() => (manySided(machine) ? undefined : machine.environments[0]?.device));
const listed = computed(() => body.value.warnings.length > 0 || body.value.lines.length > 0 || body.value.more > 0);
const doing = computed(() => machineWork(machine.key));
const turning = computed(() => sandboxesWorking(machine.key));
</script>

<template>
    <RowGroup>
        <!-- Named by the computer alone, not by every line on its face; the hover wash and focus ring are the rows' own. -->
        <RouterLink :to="deviceRoute(machine.key)" :aria-labelledby="titleId" class="ui-row-select block divide-y divide-line-subtle">
            <!-- The same mark the machine's own page leads with. -->
            <Row :chevron="true">
                <template #lead="{ mark }">
                    <span
                        class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                        :style="{ width: `${mark}px`, height: `${mark}px` }"
                    >
                        <Icon name="desktop" class="text-xs" />
                    </span>
                </template>
                <template #title>
                    <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span :id="titleId" class="font-semibold">{{ machine.label }}</span>
                        <!-- The OS beside the name: what tells two identically-labelled machines apart at a glance. -->
                        <span v-if="lone && osLabel(lone)" class="text-xs font-normal text-muted" v-tooltip.top="osTitle(lone)">{{ osLabel(lone) }}</span>
                    </span>
                </template>
                <template v-if="body.doors.length > 0" #description>{{ body.doors.join(` · `) }}</template>
                <template v-if="lone || doing" #meta>
                    <!-- What is moving on this machine, ahead of its state: the one fact here that is about to change. -->
                    <span v-if="doing" class="inline-flex min-w-0 items-center gap-1.5">
                        <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />
                        <span class="min-w-0 truncate">{{ doing }}</span>
                    </span>
                    <template v-if="lone">
                        <span v-if="lastSeenNote(lone)">{{ lastSeenNote(lone) }}</span>
                        <StatusBadge :variant="deviceTone(lone, readAt)" size="xs" :dot="true" :label="deviceState(lone, readAt)" />
                    </template>
                </template>
            </Row>

            <!-- Each side of a many-sided PC is a row like the machine page's, since a live Windows and a stopped distro
                 have no single word between them. The glyph sits in the mark's column, so every title on the card aligns. -->
            <Row v-for="environment in body.environments" :key="environment.key">
                <template #lead="{ mark, iconClass }">
                    <!-- The side whose agent is in a run turns its own glyph, as a row that IS a wait does (Row's `spin`). -->
                    <span class="flex shrink-0 justify-center text-muted" :style="{ width: `${mark}px` }">
                        <Icon
                            :name="environmentWorking(environment.key) ? `spinner` : `desktop`"
                            :spin="environmentWorking(environment.key)"
                            :class="iconClass"
                        />
                    </span>
                </template>
                <template #title>{{ environment.label }}</template>
                <template v-if="environment.doors.length > 0" #description>{{ environment.doors.join(` · `) }}</template>
                <template #meta>
                    <span v-if="environment.lastSeen">{{ environment.lastSeen }}</span>
                    <StatusBadge :variant="environment.tone" size="xs" :dot="true" :label="environment.state" />
                </template>
            </Row>

            <!-- What runs here, one line per sandbox, set under the titles above; a full row each would make the
                 preview taller than the machine it previews. -->
            <RowNote v-if="listed" v-slot="{ mark }" variant="block">
                <ul class="flex flex-col gap-2">
                    <!-- A machine-level warning qualifies every sandbox under it, so it leads them, and is never cut short. -->
                    <li v-for="warning in body.warnings" :key="warning" class="flex min-w-0 items-start gap-3 text-2xs text-warning">
                        <span class="flex h-4 shrink-0 items-center justify-center" :style="{ width: `${mark}px` }" aria-hidden="true">
                            <Icon name="exclamation-circle" />
                        </span>
                        <span class="min-w-0 break-words leading-4">{{ warning }}</span>
                    </li>
                    <li v-for="line in body.lines" :key="line.sandboxId" class="flex min-w-0 items-start gap-3">
                        <span class="flex h-4 shrink-0 items-center justify-center" :style="{ width: `${mark}px` }">
                            <!-- The status glyph turns while something is done to this sandbox, as its row does on the page. -->
                            <Icon v-if="turning.includes(line.sandboxId)" name="spinner" spin class="text-2xs text-muted" aria-hidden="true" />
                            <span
                                v-else-if="line.running !== undefined"
                                class="h-1.5 w-1.5 rounded-full"
                                :class="line.running ? `bg-success` : `bg-subtle`"
                                role="img"
                                :aria-label="line.running ? `running` : `stopped`"
                            ></span>
                            <Icon v-else name="box" class="text-2xs text-subtle" aria-hidden="true" />
                        </span>
                        <!-- Wraps rather than squeezes: on a narrow card the facts take a line of their own under the name. -->
                        <span class="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-0.5">
                            <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <span class="min-w-0 break-words text-xs text-content">{{ line.title }}</span>
                                <span v-if="line.running === false" class="text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.stopped`) }}</span>
                                <span v-else-if="line.running === undefined" class="text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.notRunningHere`) }}</span>
                                <StatusBadge v-if="line.self" variant="info" size="xs" :label="t(`sandbox.words.oneYoureUsing`)" />
                            </span>
                            <!-- Facts as a row's meta: counted and uncoloured. A warning keeps its ink: it is the reason to open this machine. -->
                            <span
                                v-if="line.facts.length > 0 || line.warnings.length > 0"
                                class="flex min-w-0 flex-wrap items-center gap-x-2.5 text-2xs tabular-nums text-subtle"
                            >
                                <span v-for="fact in line.facts" :key="fact">{{ fact }}</span>
                                <span v-for="warning in line.warnings" :key="warning" class="break-words text-warning">{{ warning }}</span>
                            </span>
                        </span>
                    </li>
                    <!-- Counted against what the machine reported, so a capped list never reads as the whole of it. -->
                    <li v-if="body.more > 0" class="flex min-w-0 gap-3 text-2xs text-subtle">
                        <span class="shrink-0" :style="{ width: `${mark}px` }" aria-hidden="true"></span>
                        {{ t(`sandbox.deviceBoardCard.more`, { more: body.more }) }}
                    </li>
                </ul>
            </RowNote>
        </RouterLink>
    </RowGroup>
</template>
