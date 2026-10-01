<script setup lang="ts">
import { Icon, StatusBadge } from "@intentic/ui";
import { computed, useId } from "vue";
import { RouterLink } from "vue-router";
import { boardBody, deviceState, deviceTone, type MachineRow, manySided } from "./deviceRows";
import { deviceRoute } from "./deviceLinks";
import { lastSeenNote, osLabel, osTitle } from "./deviceFacts";
import { useT } from "@intentic/ui/i18n";

// One physical computer, one surface, one link. Its identity leads, each environment owns its state,
// and the sandbox preview is set apart from the connections that reach it. No nested controls or disclosures.

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
// A lone environment is described in the header rather than restated in a section underneath it.
const lone = computed(() => (manySided(machine) ? undefined : machine.environments[0]?.device));
</script>

<template>
    <RouterLink
        :to="deviceRoute(machine.key)"
        :aria-labelledby="titleId"
        class="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-line-subtle bg-card transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 motion-reduce:transition-none"
    >
        <div class="flex min-w-0 flex-col gap-4 p-4">
            <div class="flex min-w-0 items-start gap-3">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-content/10 text-content" aria-hidden="true">
                    <Icon name="desktop" class="text-sm" />
                </span>
                <div class="min-w-0 flex-1">
                    <h3 :id="titleId" class="break-words text-sm font-semibold text-content">{{ machine.label }}</h3>
                    <p v-if="lone && osLabel(lone)" class="mt-0.5 break-words text-xs text-muted" v-tooltip.top="osTitle(lone)">
                        {{ osLabel(lone) }}
                    </p>
                    <p v-if="lone && lastSeenNote(lone)" class="mt-1 break-words text-2xs text-muted">{{ lastSeenNote(lone) }}</p>
                </div>
                <StatusBadge v-if="lone" :variant="deviceTone(lone, readAt)" size="xs" :dot="true" :label="deviceState(lone, readAt)" class="shrink-0" />
            </div>

            <p v-if="body.doors.length > 0" class="break-words text-2xs text-muted">{{ body.doors.join(` · `) }}</p>

            <!-- Status stays beside the environment it describes. Supporting facts get their own wrapping line. -->
            <section v-if="body.environments.length > 0" :aria-label="t(`sandbox.devicePage.environments`)" class="flex min-w-0 flex-col gap-3">
                <h4 class="text-xs font-medium text-muted">{{ t(`sandbox.devicePage.environments`) }}</h4>
                <ul class="flex min-w-0 flex-col gap-3">
                    <li v-for="environment in body.environments" :key="environment.key" class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                        <span class="min-w-0 break-words text-xs font-medium text-content">{{ environment.label }}</span>
                        <StatusBadge :variant="environment.tone" size="xs" :dot="true" :label="environment.state" class="self-start" />
                        <p v-if="environment.doors.length > 0" class="col-span-2 break-words text-2xs text-muted">
                            {{ environment.doors.join(` · `) }}
                        </p>
                        <p v-if="environment.lastSeen" class="col-span-2 break-words text-2xs text-muted">{{ environment.lastSeen }}</p>
                    </li>
                </ul>
            </section>

            <!-- A computer-level warning qualifies every sandbox underneath it. Never truncate the remedy. -->
            <div v-if="body.warnings.length > 0" class="flex min-w-0 flex-col gap-1.5">
                <p v-for="warning in body.warnings" :key="warning" class="flex min-w-0 items-start gap-2 text-2xs text-warning">
                    <Icon name="exclamation-circle" class="mt-0.5 shrink-0" aria-hidden="true" />
                    <span class="min-w-0 break-words">{{ warning }}</span>
                </p>
            </div>
        </div>

        <!-- What runs here is not another connection: the divider is that distinction, not another nested card. -->
        <section
            v-if="body.lines.length > 0 || body.more > 0"
            :aria-label="t(`sandbox.devicePage.sandboxes`)"
            class="flex min-w-0 flex-col gap-3 border-t border-line-subtle bg-overlay/30 p-4"
        >
            <h4 class="text-xs font-medium text-muted">{{ t(`sandbox.devicePage.sandboxes`) }}</h4>
            <ul class="flex min-w-0 flex-col gap-3">
                <li v-for="line in body.lines" :key="line.sandboxId" class="flex min-w-0 items-start gap-2.5">
                    <span class="mt-1 flex w-3.5 shrink-0 items-center justify-center">
                        <span
                            v-if="line.running !== undefined"
                            class="h-1.5 w-1.5 rounded-full"
                            :class="line.running ? `bg-success` : `bg-subtle`"
                            role="img"
                            :aria-label="line.running ? `running` : `stopped`"
                        ></span>
                        <Icon v-else name="box" class="text-2xs text-subtle" aria-hidden="true" />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span class="min-w-0 break-words text-xs font-medium text-content">{{ line.title }}</span>
                            <StatusBadge v-if="line.self" variant="info" size="xs" :label="t(`sandbox.words.oneYoureUsing`)" />
                            <span v-if="line.running === false" class="text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.stopped`) }}</span>
                            <span v-else-if="line.running === undefined" class="text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.notRunningHere`) }}</span>
                        </div>
                        <div v-if="line.facts.length > 0" class="flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 text-2xs text-subtle">
                            <span v-for="fact in line.facts" :key="fact" class="break-words">{{ fact }}</span>
                        </div>
                        <p v-for="warning in line.warnings" :key="warning" class="break-words text-2xs text-warning">{{ warning }}</p>
                    </div>
                </li>
            </ul>
            <p v-if="body.more > 0" class="pl-6 text-2xs text-muted">{{ t(`sandbox.deviceBoardCard.more`, { more: body.more }) }}</p>
        </section>

        <!-- This is an affordance within the one link, not a second link or a nested button. -->
        <span class="flex items-center justify-end gap-1.5 px-4 py-3 text-2xs text-link group-hover:underline">
            {{ t(`ui.action.open`) }}<Icon name="chevron-right" class="text-2xs" aria-hidden="true" />
        </span>
    </RouterLink>
</template>
