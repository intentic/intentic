<!-- What wakes a draft, said as the opened automation says it ("Every day at 09:00", "Discord live · message"), with when that next is; pressed, the panel where its kind and its details are chosen. -->
<script setup lang="ts">
import { localZone } from "@intentic/sandbox-contract/time";
import { formatDateTime, formatWhen, SegmentedControl } from "@intentic/extension-ui";
import { computed, ref, toRaw } from "vue";
import { nextIn } from "../cronSchedule";
import { scheduleSentence } from "../detail/scheduleWords";
import TriggerFields from "../fields/TriggerFields.vue";
import { useTriggerKinds } from "../fields/triggerKinds";
import PropertyPopover from "../properties/PropertyPopover.vue";
import PropertyRow from "../properties/PropertyRow.vue";
import { EDITABLE_VALUE } from "../properties/propertyLook";
import type { AutomationFormState } from "../useAutomationForm";
import { t } from "../i18n.js";

const props = defineProps<{ state: AutomationFormState }>();
const { form, schedule, effectiveCron, effectiveZone, cronPreview, onceAt, onceError, listenerSource, isVisitorChat } = props.state;
const { TRIGGER_TABS, whenCaption, kind } = useTriggerKinds(props.state);

// The trigger in the words the row will use once it exists.
const said = computed<{ readonly text: string; readonly code?: boolean; readonly unset?: boolean }>(() => {
    switch (form.kind) {
        case `schedule`: {
            const cron = effectiveCron.value;
            const sentence = cron === undefined ? undefined : scheduleSentence(cron, localZone(), effectiveZone.value);
            return sentence === undefined ? { text: cron ?? schedule.cron, code: true } : { text: sentence };
        }
        case `once`:
            return Number.isNaN(onceAt.value) ? { text: t(`whenProperty.pickMoment`), unset: true } : { text: t(`scheduleProperty.onceAt`, { at: formatDateTime(onceAt.value) }) };
        case `event`:
            return { text: t(`whenProperty.webhook`) };
        case `workspace`:
            return { text: form.workspaceEvent === `agent.landed` ? t(`automationFields.workLands`) : t(`automationFields.turnSettles`) };
        case `listener`: {
            const event = listenerSource.value.events.find((option) => option.value === form.eventType)?.label;
            return { text: [isVisitorChat.value ? listenerSource.value.label : t(`automationRow.sourceLive`, { source: listenerSource.value.label }), event].filter(Boolean).join(` · `) };
        }
    }
    return { text: `` };
});

// What it means now, or what stops it: the next run on the reader's own clock, how far off a moment is, or the problem.
const note = computed<{ readonly text: string; readonly danger: boolean } | undefined>(() => {
    if (form.kind === `schedule`) {
        const preview = cronPreview.value;
        if (preview !== undefined && `error` in preview) {
            return { text: preview.error, danger: true };
        }
        const next = preview?.runs[0];
        return next === undefined ? undefined : { text: t(`scheduleProperty.next`, { when: formatWhen(next), in: nextIn(next) }), danger: false };
    }
    if (form.kind === `once` && !Number.isNaN(onceAt.value)) {
        return onceError.value === undefined ? { text: t(`automationFields.firesIn`, { when: nextIn(onceAt.value) }), danger: false } : { text: onceError.value, danger: true };
    }
    return form.kind === `event` ? { text: t(`whenProperty.urlAfter`), danger: false } : undefined;
});

/* ---- changing it: every change lands in the draft as it is made; Cancel puts back what it was ---- */

const anchor = ref<HTMLElement>();
const open = ref(false);
let before: { form: typeof form; schedule: typeof schedule } | undefined;
const begin = (): void => {
    before = structuredClone({ form: toRaw(form), schedule: toRaw(schedule) });
    open.value = true;
};
const cancel = (): void => {
    if (before !== undefined) {
        Object.assign(form, before.form);
        Object.assign(schedule, before.schedule);
    }
};
</script>

<template>
    <PropertyRow :label="t(`whenProperty.when`)">
        <button ref="anchor" type="button" :class="EDITABLE_VALUE" :aria-label="t(`whenProperty.change`, { now: said.text })" @click="begin">
            <span class="text-sm" :class="[said.unset ? `text-subtle` : `text-content`, said.code ? `font-mono` : ``]">{{ said.text }}</span>
            <span v-if="note" class="text-xs" :class="note.danger ? `text-danger` : `text-subtle`">{{ note.text }}</span>
        </button>

        <PropertyPopover v-model="open" :anchor="anchor" :header="t(`whenProperty.when`)" wide @save="open = false" @cancel="cancel">
            <SegmentedControl v-model="kind" :options="TRIGGER_TABS" stretch />
            <p class="text-2xs text-subtle">{{ whenCaption }}</p>
            <!-- A Visitor chat's sites are a section of the draft's own, not a corner of this panel. -->
            <TriggerFields :state="state" :sites="false" />
        </PropertyPopover>
    </PropertyRow>
</template>
