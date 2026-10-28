<!-- What a trigger listens for, by kind: a workspace moment, a live source and its filters, a moment, or a schedule; and, for CI, how its events arrive. The kind itself is picked by whoever draws this. -->
<script setup lang="ts">
import { Icon, ToggleSwitch, ui } from "@intentic/extension-ui";
import { computed } from "vue";
import { glyph } from "../catalog";
import { nextIn } from "../cronSchedule";
import MomentField from "../schedule/MomentField.vue";
import ScheduleFields from "../schedule/ScheduleFields.vue";
import { useCiDelivery } from "../useCiDelivery";
import type { AutomationFormState } from "../useAutomationForm";
import VisitorChatFields from "./VisitorChatFields.vue";
import { t } from "../i18n.js";

const { state, sites = true } = defineProps<{
    state: AutomationFormState;
    /** Whether a Visitor chat's sites and door are drawn here; a surface that gives them a section of their own says no. */
    sites?: boolean;
}>();
const { form, schedule, isVisitorChat, listenerSource, branchField, visibleSources, cronPreview, effectiveZone, sandboxZone, touched, markTouched, onceAt, onceError } =
    state;

// Worded as the moment, not the wire event id, since two ids can fire on the same turn and read as one.
const WORKSPACE_EVENTS = computed(
    () =>
        [
            { value: `turn.settled`, label: t(`automationFields.turnSettles`), hint: t(`automationFields.afterEveryIsolatedAgent`) },
            { value: `agent.landed`, label: t(`automationFields.workLands`), hint: t(`automationFields.onlyAgentsWorkActually`) },
        ] as const,
);

// RETIRED MOMENTS, never offered: `deps.broken` and `deps.fixed` were the edges of the check that ran after every land,
// which is gone, so nothing emits them. An automation written for one still opens as what it is, its moment drawn
// pressed and marked retired, with the sentence that it never fires, rather than as a form with nothing chosen.
const retiredEvent = computed(() => {
    if (form.workspaceEvent === `deps.broken`) {
        return { label: t(`automationFields.checksBreak`) };
    }
    return form.workspaceEvent === `deps.fixed` ? { label: t(`automationFields.checksRecover`) } : undefined;
});

// Clears the event filter on switch, since an old filter (e.g. `pipeline_failed`) may match nothing on the new source.
const setProvider = (provider: string): void => {
    form.provider = provider;
    form.eventType = undefined;
};

// CI's delivery path: instant, polled, or never; fetched only while a CI trigger is on screen.
const isCi = computed(() => form.kind === `listener` && form.provider === `ci`);
const { delivery } = useCiDelivery(
    isCi,
    computed(() => form.channelId),
);
const DELIVERY_TONE = {
    ok: `text-muted`,
    polling: `text-warning`,
    none: `text-danger`,
} as const;
const DELIVERY_ICON = {
    ok: `check-circle`,
    polling: `clock`,
    none: `exclamation-triangle`,
} as const;
</script>

<template>
    <div class="@container flex flex-col gap-3">
        <!-- The trigger selects the event and optional repository to watch. -->
        <template v-if="form.kind === 'workspace'">
            <div class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.wake`) }}</span>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="option in WORKSPACE_EVENTS"
                        :key="option.value"
                        type="button"
                        :class="ui.chip({ on: form.workspaceEvent === option.value })"
                        :aria-pressed="form.workspaceEvent === option.value"
                        @click="form.workspaceEvent = option.value"
                    >
                        {{ option.label }}
                    </button>
                    <!-- Not a choice: the moment this automation already names, which nothing sends any more. -->
                    <span v-if="retiredEvent !== undefined" data-retired-trigger :class="ui.chip({ on: true }, `text-subtle`)">
                        <span class="line-through">{{ retiredEvent.label }}</span>
                        <span class="text-2xs">{{ t(`automationFields.retired`) }}</span>
                    </span>
                </div>
                <span v-if="retiredEvent !== undefined" class="text-2xs text-warning">{{ t(`automationFields.retiredNeverFires`) }}</span>
                <span v-else class="text-2xs text-subtle">
                    {{ WORKSPACE_EVENTS.find((option) => option.value === form.workspaceEvent)?.hint }}
                </span>
            </div>
            <label class="ui-field max-w-sm">
                <span class="text-xs text-subtle">{{ t(`automationFields.onlyRepoOptional`) }}</span>
                <input
                    v-model="form.repo"
                    :placeholder="t(`automationFields.everyRepoChangeTouched`)"
                    class="font-mono"
                    :class="ui.input()"
                />
            </label>
        </template>

        <template v-if="form.kind === 'listener'">
            <!-- Chips identify choices compactly and wrap when needed. -->
            <div class="ui-field">
                <span class="text-xs text-subtle">{{ t(`automationFields.source`) }}</span>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="source in visibleSources"
                        :key="source.provider"
                        type="button"
                        :class="ui.chip({ on: form.provider === source.provider })"
                        :aria-pressed="form.provider === source.provider"
                        :disabled="!source.available"
                        @click="setProvider(source.provider)"
                    >
                        <img v-if="source.logo" :src="`https://cdn.simpleicons.org/${source.logo}`" class="h-3.5 w-3.5" alt="" />
                        <Icon v-else :name="glyph(source.icon) ?? 'bolt'" class="text-2xs" />
                        {{ source.label }}
                        <span v-if="!source.available" class="text-warning">{{ t(`automationFields.unavailable`) }}</span>
                    </button>
                </div>
            </div>

            <!-- A Visitor chat's sites and door: here, unless the surface shows them as a section of their own. -->
            <template v-if="isVisitorChat">
                <VisitorChatFields v-if="sites" :state="state" />
            </template>

            <div v-else class="grid gap-3 @2xl:grid-cols-2">
                <div class="ui-field @2xl:col-span-2">
                    <span class="text-xs text-subtle">{{ t(`automationFields.events`) }}</span>
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            type="button"
                            :class="ui.chip({ on: form.eventType === undefined })"
                            :aria-pressed="form.eventType === undefined"
                            @click="form.eventType = undefined"
                        >
                            {{ t(`automationFields.any`) }}
                        </button>
                        <button
                            v-for="eventOption in listenerSource.events"
                            :key="eventOption.value"
                            type="button"
                            :class="ui.chip({ on: form.eventType === eventOption.value })"
                            :aria-pressed="form.eventType === eventOption.value"
                            @click="form.eventType = eventOption.value"
                        >
                            {{ eventOption.label }}
                        </button>
                    </div>
                    <label
                        v-if="form.eventType === 'message' && listenerSource.mentionLabel"
                        class="flex items-center gap-2 text-xs text-muted"
                    >
                        <ToggleSwitch v-model="form.mentioned" :aria-label="listenerSource.mentionLabel" />
                        {{ listenerSource.mentionLabel }}
                    </label>
                </div>
                <label class="ui-field">
                    <span class="text-xs text-subtle">{{ listenerSource.channel.label }}</span>
                    <input v-model="form.channelId" :placeholder="listenerSource.channel.placeholder" class="font-mono" :class="ui.input()" />
                </label>
                <!-- CI's own second narrowing axis (branch); without it, "wake on CI failure" means every agent's branch too. -->
                <label v-if="branchField" class="ui-field">
                    <span class="text-xs text-subtle">{{ branchField.label }}</span>
                    <input v-model="form.branch" :placeholder="branchField.placeholder" class="font-mono" :class="ui.input()" />
                    <p class="text-2xs text-subtle">{{ branchField.hint }}</p>
                </label>
            </div>
        </template>

        <!-- A day off the month's grid and a time beside it, on the reader's own clock, which is how they mean it; what
             gets stored is the instant that resolves to. -->
        <template v-if="form.kind === 'once'">
            <MomentField v-model="form.onceAt" :min="Date.now()" @update:model-value="markTouched(`onceAt`)" />
            <p v-if="onceError && touched.has(`onceAt`)" class="text-xs text-danger">{{ onceError }}</p>
            <!-- The same proof the cron preview gives: how far off the moment they picked actually is. -->
            <p v-else-if="!onceError" class="text-xs text-muted">{{ t(`automationFields.firesIn`, { when: nextIn(onceAt) }) }}</p>
        </template>

        <ScheduleFields
            v-if="form.kind === 'schedule'"
            v-model:tz="form.tz"
            v-model:after-sessions="form.afterSessions"
            :schedule="schedule"
            :preview="cronPreview"
            :zone="effectiveZone"
            :sandbox-zone="sandboxZone"
        />

        <!-- CI has no held-open gateway: its events arrive by webhook, or by polling if that couldn't register. -->
        <p v-if="isCi && delivery" class="flex items-start gap-1.5 text-xs" :class="DELIVERY_TONE[delivery.state]">
            <Icon :name="DELIVERY_ICON[delivery.state]" class="shrink-0 text-2xs" />
            <span>
                {{ delivery.summary }}
                <span v-if="delivery.detail" class="mt-1 block text-2xs text-subtle">{{ delivery.detail }}</span>
            </span>
        </p>
    </div>
</template>
