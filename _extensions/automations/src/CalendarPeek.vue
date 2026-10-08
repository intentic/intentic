<script setup lang="ts">
import type { AutomationRun, AutomationSummary } from "@intentic/sandbox-contract";
import { localZone } from "@intentic/sandbox-contract/time";
import { Button, formatDateTime, Icon, type IconName, ToggleSwitch } from "@intentic/extension-ui";
import { computed } from "vue";
import type { EntryState } from "./calendarModel";
import { nextIn, scheduleTriggerLabel } from "./cronSchedule";
import { host } from "./host";
import RunStrip from "./RunStrip.vue";
import { useSandboxZone } from "./useAutomations";
import { t } from "./i18n.js";

// What one slot on the calendar is, and the three things worth doing about it from there: run it, edit it, switch it.
// The moment comes first because it is what was clicked; the automation's standing facts (its rule, its guard, its
// prompt) follow. Deleting stays on the list, where its confirmation and the rest of the row's history live.

const props = defineProps<{
    automation: AutomationSummary;
    /** The slot's own moment and what it says. Absent for a lane bar, which stands for a cadence, not a moment. */
    at?: number;
    state?: EntryState;
    run?: AutomationRun;
    busy?: boolean;
}>();
const emit = defineEmits<{ run: []; edit: []; toggle: [enabled: boolean] }>();

const sandboxZone = useSandboxZone();
const trigger = computed(() => props.automation.trigger);

const rule = computed<string>(() => {
    const fires = trigger.value;
    if (fires.kind === `schedule`) {
        return scheduleTriggerLabel(fires, localZone(), sandboxZone.value);
    }
    return fires.kind === `once` ? t(`calendar.peek.oneTime`) : ``;
});

// Same reading as the row's: off, with its one moment behind it, is a reminder delivered, not one cancelled.
const spent = computed(() => trigger.value.kind === `once` && !props.automation.enabled && trigger.value.at <= Date.now());

const STATE: Record<EntryState, { icon: IconName; tone: string }> = {
    upcoming: { icon: `clock`, tone: `text-link` },
    paused: { icon: `pause`, tone: `text-subtle` },
    completed: { icon: `check`, tone: `text-muted` },
    error: { icon: `exclamation-circle`, tone: `text-danger` },
    skipped: { icon: `minus`, tone: `text-subtle` },
    interrupted: { icon: `minus`, tone: `text-subtle` },
};
const moment = computed(() => (props.state === undefined ? undefined : STATE[props.state]));
const ahead = computed(() => props.state === `upcoming` || props.state === `paused`);

// Why a moment on the calendar may still not wake anything: said beside the moment, since that is where it misleads.
const caveats = computed<string[]>(() => {
    const fires = trigger.value;
    return [
        ...(props.automation.guard ? [t(`calendar.peek.guarded`)] : []),
        ...(fires.kind === `schedule` && fires.afterSessions !== undefined
            ? [t(`calendar.peek.afterSessions`, { count: fires.afterSessions }, fires.afterSessions)]
            : []),
    ];
});

const openTranscript = (): void => {
    if (props.run?.conversationId !== undefined) {
        host().chat.openSession(props.run.conversationId);
    }
};
</script>

<template>
    <div class="flex flex-col gap-3 text-xs">
        <div class="flex items-start gap-2.5">
            <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-overlay text-muted">
                <Icon :name="trigger.kind === `once` ? `pin` : `clock`" class="text-xs" />
            </span>
            <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-semibold text-content">{{ automation.id }}</div>
                <div class="truncate text-2xs text-subtle">{{ rule }}</div>
            </div>
            <ToggleSwitch
                :model-value="automation.enabled"
                :disabled="busy || spent"
                :aria-label="t(`automationRow.enable`, { id: automation.id })"
                @update:model-value="emit(`toggle`, $event)"
            />
        </div>

        <!-- The slot itself: what happened, or what will. -->
        <div v-if="moment && at !== undefined" class="flex flex-col gap-1 rounded-md bg-content/4 px-2.5 py-2">
            <div class="flex items-center gap-1.5" :class="moment.tone">
                <Icon :name="moment.icon" class="shrink-0 text-2xs" />
                <span class="font-medium">{{ t(`calendar.state.${state}`) }}</span>
                <span class="text-muted">{{ formatDateTime(at) }}</span>
                <span v-if="state === `upcoming`" class="ml-auto shrink-0 text-subtle">{{ nextIn(at) }}</span>
            </div>
            <p v-if="run?.detail" class="text-2xs text-muted">{{ run.detail }}</p>
            <template v-if="ahead">
                <p v-for="caveat in caveats" :key="caveat" class="text-2xs text-subtle">{{ caveat }}</p>
            </template>
            <button v-if="run?.conversationId" type="button" class="flex cursor-pointer items-center gap-1 self-start text-2xs text-link hover:underline" @click="openTranscript">
                {{ t(`calendar.peek.openTranscript`) }}
                <Icon name="chevron-right" class="text-3xs" />
            </button>
        </div>

        <!-- A lane bar is a cadence: what came lately and when it comes next stand in for the moment. -->
        <div v-else class="flex items-center gap-2 rounded-md bg-content/4 px-2.5 py-2 text-2xs">
            <span class="text-muted">{{ automation.nextRun !== undefined ? t(`calendar.peek.nextIn`, { when: nextIn(automation.nextRun) }) : t(`calendar.peek.switchedOff`) }}</span>
            <span class="ml-auto w-14 shrink-0"><RunStrip :runs="automation.runs" /></span>
        </div>

        <p class="line-clamp-4 text-2xs leading-relaxed whitespace-pre-wrap text-muted">{{ automation.prompt }}</p>

        <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-2.5">
            <Button :label="t(`automationRow.runNow2`)" size="small" tier="quiet" :disabled="busy" @click="emit(`run`)">
                <template #icon><Icon name="play" /></template>
            </Button>
            <Button :label="t(`automationRow.edit2`)" size="small" tier="boring" @click="emit(`edit`)">
                <template #icon><Icon name="pencil" /></template>
            </Button>
        </div>
    </div>
</template>
