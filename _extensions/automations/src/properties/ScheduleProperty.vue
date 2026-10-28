<!-- When an automation runs, said as a sentence with when it runs next, and changed where it is said. -->
<script setup lang="ts">
import type { Automation, AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { asZone, localZone, type Zone } from "@intentic/sandbox-contract/time";
import { formatDateTime, formatWhen } from "@intentic/extension-ui";
import { computed, reactive, ref } from "vue";
import { cronOf, defaultSchedule, instantOf, localInputOf, nextIn, parseCron, previewOf } from "../cronSchedule";
import { scheduleSentence } from "../detail/scheduleWords";
import MomentField from "../schedule/MomentField.vue";
import ScheduleFields from "../schedule/ScheduleFields.vue";
import { useSandboxZone } from "../useAutomations";
import PropertyPopover from "./PropertyPopover.vue";
import PropertyRow from "./PropertyRow.vue";
import { EDITABLE_VALUE, FIXED_VALUE } from "./propertyLook";
import { useAutomationPatch } from "./useAutomationPatch";
import { t } from "../i18n.js";

const props = defineProps<{
    automation: AutomationSummary;
    // What fires it in the row's own words, for the triggers that are not a clock (a message, a webhook, a landing).
    triggerLabel: string;
    // A one-time wake that already fired.
    spent: boolean;
}>();

const trigger = computed(() => props.automation.trigger);
const sandboxZone = useSandboxZone();
const clock = computed(() => trigger.value.kind === `schedule` || trigger.value.kind === `once`);

// The rule in words on its own clock, or the cron itself when it is a shape with no words, set in code so it reads as
// the rule rather than as a broken sentence.
const said = computed<{ readonly text: string; readonly code: boolean }>(() => {
    const fires = trigger.value;
    if (fires.kind === `schedule`) {
        const sentence = scheduleSentence(fires.cron, localZone(), asZone(fires.tz) ?? sandboxZone.value);
        return sentence === undefined ? { text: fires.cron, code: true } : { text: sentence, code: false };
    }
    if (fires.kind === `once`) {
        return { text: t(`scheduleProperty.onceAt`, { at: formatDateTime(fires.at) }), code: false };
    }
    return { text: props.triggerLabel, code: false };
});

// What it means for the reader now: when it next runs, on their own clock, or why it will not.
const notes = computed<readonly string[]>(() => {
    const next = props.automation.nextRun;
    const fires = trigger.value;
    const when = props.spent
        ? t(`automationRow.alreadyFired`)
        : next !== undefined && props.automation.enabled
          ? t(`scheduleProperty.next`, { when: formatWhen(next), in: nextIn(next) })
          : clock.value && !props.automation.enabled
            ? t(`scheduleProperty.offNotScheduled`)
            : undefined;
    const sessions = fires.kind === `schedule` && fires.afterSessions !== undefined ? fires.afterSessions : 0;
    return [
        ...(when === undefined ? [] : [when]),
        ...(sessions > 0 ? [t(`scheduleProperty.afterSessions`, { count: sessions }, sessions)] : []),
    ];
});

/* ---- changing it ---- */

const anchor = ref<HTMLElement>();
const open = ref(false);
const { patch, error, saving } = useAutomationPatch(computed(() => props.automation));

// Drafts, seeded from what is stored each time the panel opens, so a cancelled change leaves nothing behind.
const draft = reactive(defaultSchedule());
const tz = ref(``);
const afterSessions = ref(0);
const onceAt = ref(``);
const draftZone = computed<Zone>(() => asZone(tz.value) ?? sandboxZone.value);
const draftCron = computed(() => cronOf(draft));
const preview = computed(() => previewOf(draftCron.value, draftZone.value));
const onceInstant = computed(() => instantOf(onceAt.value));
const onceError = computed(() => (Number.isNaN(onceInstant.value) || onceInstant.value > Date.now() ? undefined : t(`useAutomationForm.momentPassed`)));
const canSave = computed(() =>
    trigger.value.kind === `once` ? !Number.isNaN(onceInstant.value) && onceError.value === undefined : preview.value !== undefined && `runs` in preview.value,
);

const begin = (): void => {
    const fires = trigger.value;
    error.value = undefined;
    if (fires.kind === `schedule`) {
        Object.assign(draft, parseCron(fires.cron));
        tz.value = fires.tz ?? ``;
        afterSessions.value = fires.afterSessions ?? 0;
    } else if (fires.kind === `once`) {
        onceAt.value = localInputOf(fires.at);
    }
    open.value = true;
};

// The trigger as the form writes it (useAutomationForm `scheduleTrigger`): no zone stored for the sandbox's own, no
// session bar for zero, so moving the sandbox's clock still moves every schedule that never asked for another.
const nextTrigger = (): Automation[`trigger`] => {
    if (trigger.value.kind === `once`) {
        return { kind: `once`, at: onceInstant.value };
    }
    const next: Extract<Automation[`trigger`], { kind: `schedule` }> = { kind: `schedule`, cron: draftCron.value ?? `` };
    const zone = asZone(tz.value);
    if (zone !== undefined) {
        next.tz = zone;
    }
    if (afterSessions.value > 0) {
        next.afterSessions = afterSessions.value;
    }
    return next;
};

const save = async (): Promise<void> => {
    if (await patch((stored) => ({ ...stored, trigger: nextTrigger() }))) {
        open.value = false;
    }
};
</script>

<template>
    <PropertyRow :label="trigger.kind === `schedule` ? t(`scheduleProperty.schedule`) : t(`scheduleProperty.trigger`)">
        <button
            v-if="clock"
            ref="anchor"
            type="button"
            :class="EDITABLE_VALUE"
            :aria-label="t(`scheduleProperty.change`, { now: said.text })"
            @click="begin"
        >
            <span class="text-sm text-content" :class="said.code ? `font-mono` : ``">{{ said.text }}</span>
            <span v-for="note in notes" :key="note" class="text-xs text-subtle">{{ note }}</span>
        </button>
        <div v-else :class="FIXED_VALUE">
            <span class="text-sm text-content">{{ said.text }}</span>
            <span v-for="note in notes" :key="note" class="text-xs text-subtle">{{ note }}</span>
        </div>

        <PropertyPopover
            v-model="open"
            :anchor="anchor"
            :header="t(`scheduleProperty.schedule`)"
            :saving="saving"
            :error="error"
            :can-save="canSave"
            wide
            @save="save"
        >
            <ScheduleFields
                v-if="trigger.kind === `schedule`"
                v-model:tz="tz"
                v-model:after-sessions="afterSessions"
                :schedule="draft"
                :preview="preview"
                :zone="draftZone"
                :sandbox-zone="sandboxZone"
            />
            <template v-else>
                <MomentField v-model="onceAt" :min="Date.now()" />
                <span v-if="onceError" class="text-xs text-danger">{{ onceError }}</span>
                <span v-else-if="!Number.isNaN(onceInstant)" class="text-xs text-muted">{{ t(`automationFields.firesIn`, { when: nextIn(onceInstant) }) }}</span>
            </template>
        </PropertyPopover>
    </PropertyRow>
</template>
