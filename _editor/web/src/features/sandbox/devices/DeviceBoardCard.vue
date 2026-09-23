<script setup lang="ts">
import { Icon, Row, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { boardBody, deviceState, deviceTone, type MachineRow, manySided } from "./deviceRows";
import { deviceRoute } from "./deviceLinks";
import { lastSeenNote, osLabel, osTitle } from "./deviceFacts";
import { useT } from "@intentic/ui/i18n";

// One machine on the board: what it is, whether it wants anything, and a line per sandbox it holds. Nothing
// here expands and nothing here is a control — the whole card is one link into that machine's own page —
// so a reader answering "which machine has 8788" never has to press anything. A PC with several environments
// (Windows and the distros on it) is one card whose environments are lines of their own, each with its own
// state, and whose sandboxes are listed once.

const t = useT();

const { machine, needle, ownSlug, readAt } = defineProps<{
    machine: MachineRow;
    /** The board's filter, lower-cased; every matching sandbox is drawn while it is set. */
    needle: string;
    ownSlug: string | undefined;
    /** When this reading landed; the machine is judged as of then, not as of now. */
    readAt: number;
}>();

const body = computed(() => boardBody(machine, needle, ownSlug, readAt));
const hasBelow = computed(
    () => body.value.environments.length > 0 || body.value.warnings.length > 0 || body.value.lines.length > 0 || body.value.more > 0,
);
// The one device of a one-environment machine, whose facts and state ride the card itself.
const lone = computed(() => (manySided(machine) ? undefined : machine.environments[0]?.device));
</script>

<template>
    <RouterLink :to="deviceRoute(machine.key)" class="block">
        <!-- `spine` hangs the sandbox lines off the machine's own mark, so a card reads as one machine's worth. -->
        <Row :interactive="true" :chevron="true" :spine="hasBelow">
            <template #lead="{ mark }">
                <span
                    class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                    :style="{ width: `${mark}px`, height: `${mark}px` }"
                >
                    <Icon name="desktop" class="text-xs" />
                </span>
            </template>

            <template #title>
                <span class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span class="min-w-0 truncate font-semibold">{{ machine.label }}</span>
                    <!-- The OS beside the name: what tells two identically-labelled machines apart at a glance. -->
                    <span v-if="lone && osLabel(lone)" class="shrink-0 truncate text-xs font-normal text-muted" :title="osTitle(lone)">
                        {{ osLabel(lone) }}
                    </span>
                </span>
            </template>

            <!-- A lone device's doors and agent build; a many-sided machine says these per environment below. -->
            <template v-if="body.doors.length > 0" #description>
                <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs">
                    <template v-for="(door, index) in body.doors" :key="door">
                        <span v-if="index > 0" class="text-subtle" aria-hidden="true">·</span>
                        <span>{{ door }}</span>
                    </template>
                </span>
            </template>

            <template v-if="lone" #meta>
                <span v-if="lastSeenNote(lone)" class="shrink-0">{{ lastSeenNote(lone) }}</span>
                <StatusBadge :variant="deviceTone(lone, readAt)" size="xs" :dot="true" :label="deviceState(lone, readAt)" class="shrink-0" />
            </template>

            <template v-if="hasBelow" #below>
                <!-- Every line's lead sits in a fixed-width column so dots, icons and empty leads align. -->
                <div class="flex min-w-0 flex-col gap-2">
                    <!-- One line per environment: what it is, how it is reached, and its own state. -->
                    <div v-for="environment in body.environments" :key="environment.key" class="flex min-w-0 items-center gap-x-2.5">
                        <span class="flex w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                            <Icon name="desktop" class="text-2xs text-subtle" />
                        </span>
                        <span class="min-w-0 truncate text-xs text-content">{{ environment.label }}</span>
                        <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-2xs text-subtle">
                            <template v-for="(door, index) in environment.doors" :key="door">
                                <span v-if="index > 0" aria-hidden="true">·</span>
                                <span>{{ door }}</span>
                            </template>
                        </span>
                        <span class="ml-auto flex shrink-0 items-center gap-x-2.5 pl-3">
                            <span v-if="environment.lastSeen" class="text-2xs text-muted">{{ environment.lastSeen }}</span>
                            <StatusBadge :variant="environment.tone" size="xs" :dot="true" :label="environment.state" />
                        </span>
                    </div>
                    <!-- Machine status qualifies every sandbox connection. -->
                    <p v-for="warning in body.warnings" :key="warning" class="flex min-w-0 items-center gap-x-2.5 text-2xs text-warning">
                        <span class="flex w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                            <Icon name="exclamation-circle" class="text-2xs" />
                        </span>
                        {{ warning }}
                    </p>
                    <!-- One line per sandbox: the running dot, the name, and what its ports came to. -->
                    <div v-for="line in body.lines" :key="line.sandboxId" class="flex min-w-0 items-center gap-x-2.5">
                        <!-- Fixed-width lead column: dot or icon, centred to the same width as the environment icon above. -->
                        <span class="flex w-3.5 shrink-0 items-center justify-center">
                            <span
                                v-if="line.running !== undefined"
                                class="h-1.5 w-1.5 rounded-full"
                                :class="line.running ? `bg-success` : `bg-subtle`"
                                role="img"
                                :aria-label="line.running ? `running` : `stopped`"
                            ></span>
                            <Icon v-else name="box" class="text-2xs text-subtle" />
                        </span>
                        <span class="min-w-0 truncate text-xs text-content">{{ line.title }}</span>
                        <span v-if="line.running === false" class="shrink-0 text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.stopped`) }}</span>
                        <span v-else-if="line.running === undefined" class="shrink-0 text-2xs text-muted">{{
                            t(`sandbox.deviceBoardCard.notRunningHere`)
                        }}</span>
                        <StatusBadge v-if="line.self" variant="info" size="xs" :label="t(`shared.oneYoureUsing`)" class="shrink-0" />
                        <!-- Facts are counted and uncoloured; a warning keeps its ink and is the reason to open this machine. -->
                        <span class="ml-auto flex min-w-0 shrink items-center gap-x-2.5 pl-3">
                            <span v-for="fact in line.facts" :key="fact" class="shrink-0 text-2xs text-subtle">{{ fact }}</span>
                            <span v-for="warning in line.warnings" :key="warning" class="truncate text-2xs text-warning">{{ warning }}</span>
                        </span>
                    </div>
                    <!-- Counted against what the machine reported, so a capped list never reads as the whole of it. -->
                    <p v-if="body.more > 0" class="flex min-w-0 items-center gap-x-2.5 text-2xs text-subtle">
                        <span class="w-3.5 shrink-0" aria-hidden="true"></span>
                        {{ t(`sandbox.deviceBoardCard.more`, { more: body.more }) }}
                    </p>
                </div>
            </template>
        </Row>
    </RouterLink>
</template>
