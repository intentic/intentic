<script setup lang="ts">
import { Icon, Row, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { boardBody, type DeviceRow, deviceState, deviceTone } from "./deviceRows";
import { deviceRoute } from "./deviceLinks";
import { lastSeenNote, osLabel, osTitle } from "./deviceFacts";

// One machine on the board: what it is, whether it wants anything, and a line per sandbox it holds. Nothing
// here expands and nothing here is a control — the whole card is one link into that machine's own page —
// so a reader answering "which machine has 8788" never has to press anything.

const { row, needle, ownSlug, readAt } = defineProps<{
    row: DeviceRow;
    /** The board's filter, lower-cased; every matching sandbox is drawn while it is set. */
    needle: string;
    ownSlug: string | undefined;
    /** When this reading landed; the machine is judged as of then, not as of now. */
    readAt: number;
}>();

const body = computed(() => boardBody(row, needle, ownSlug, readAt));
</script>

<template>
    <RouterLink :to="deviceRoute(row.device.key)" class="block">
        <!-- `spine` hangs the sandbox lines off the machine's own mark, so a card reads as one machine's worth. -->
        <Row :interactive="true" :chevron="true" :spine="body.lines.length > 0 || body.warnings.length > 0">
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
                    <span class="min-w-0 truncate font-semibold">{{ row.device.label }}</span>
                    <!-- The OS beside the name: what tells two identically-labelled machines apart at a glance. -->
                    <span v-if="osLabel(row.device)" class="shrink-0 truncate text-xs font-normal text-muted" :title="osTitle(row.device)">
                        {{ osLabel(row.device) }}
                    </span>
                </span>
            </template>

            <!--
                The doors this sandbox reaches the machine through, and the build its agent serves; the counts a
                folded row used to carry are drawn as lines below instead.
            -->
            <template #description>
                <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs">
                    <template v-for="(door, index) in body.doors" :key="door">
                        <span v-if="index > 0" class="text-subtle" aria-hidden="true">·</span>
                        <span>{{ door }}</span>
                    </template>
                </span>
            </template>

            <template #meta>
                <span v-if="lastSeenNote(row.device)" class="shrink-0">{{ lastSeenNote(row.device) }}</span>
                <StatusBadge
                    :variant="deviceTone(row.device, readAt)"
                    size="xs"
                    :dot="true"
                    :label="deviceState(row.device, readAt)"
                    class="shrink-0"
                />
            </template>

            <template #below>
                <div class="flex min-w-0 flex-col gap-1">
                    <!--
                        What is wrong with the machine itself, ABOVE the sandbox lines: it qualifies all of them, and at
                        the foot of the list it read as the last one's own warning.
                    -->
                    <p v-for="warning in body.warnings" :key="warning" class="flex min-w-0 items-center gap-1.5 text-2xs text-warning">
                        <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                        {{ warning }}
                    </p>
                    <!--
                        One line per sandbox, at the same size as any other read value: the running dot, the name, and
                        what its ports came to.
                    -->
                    <div v-for="line in body.lines" :key="line.sandboxId" class="flex min-w-0 items-center gap-x-2">
                        <!-- Running is a dot alone, the resting state; a pairing with no container here gets a box. -->
                        <span
                            v-if="line.running !== undefined"
                            class="h-1.5 w-1.5 shrink-0 rounded-full"
                            :class="line.running ? `bg-success` : `bg-subtle`"
                            role="img"
                            :aria-label="line.running ? `running` : `stopped`"
                        ></span>
                        <Icon v-else name="box" class="shrink-0 text-2xs text-subtle" />
                        <span class="min-w-0 truncate text-xs text-content">{{ line.title }}</span>
                        <span v-if="line.running === false" class="shrink-0 text-2xs text-muted">stopped</span>
                        <span v-else-if="line.running === undefined" class="shrink-0 text-2xs text-muted">not running here</span>
                        <StatusBadge v-if="line.self" variant="info" size="xs" label="the one you're using" class="shrink-0" />
                        <!-- Facts are counted and uncoloured; a warning keeps its ink and is the reason to open this machine. -->
                        <span class="ml-auto flex min-w-0 shrink items-center gap-x-2 pl-2">
                            <span v-for="fact in line.facts" :key="fact" class="shrink-0 text-2xs text-subtle">{{ fact }}</span>
                            <span v-for="warning in line.warnings" :key="warning" class="truncate text-2xs text-warning">{{ warning }}</span>
                        </span>
                    </div>
                    <!-- Counted against what the machine reported, so a capped list never reads as the whole of it. -->
                    <p v-if="body.more > 0" class="text-2xs text-subtle">… and {{ body.more }} more</p>
                </div>
            </template>
        </Row>
    </RouterLink>
</template>
