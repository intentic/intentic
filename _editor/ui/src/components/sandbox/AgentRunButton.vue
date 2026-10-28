<script setup lang="ts">
import Button from "../primitives/Button.vue";
import type { ButtonTier, ButtonTone } from "../primitives/button.js";
import { type ComponentPublicInstance, computed, ref } from "vue";
import Icon from "../primitives/Icon.vue";
import type { AgentRunPicker } from "../../composables/useAgentRunPick.js";
import type { IconName } from "../../icons/iconSets.js";
import { useT } from "../../i18n/index.js";
import type { Tip, TooltipValue } from "../../lib/tooltip.js";

const t = useT();

/* THE BUTTON THAT STARTS AN AGENT FOR YOU: Fix with agent on a failed pipeline, Ask the agent to fix on a broken container, Run a chore, Run all 21 stories. */

const {
    label,
    picker,
    tier = undefined,
    tone = undefined,
    severity = undefined,
    size = `small`,
    text = false,
    icon = undefined,
    loading = false,
    disabled = false,
    hint = undefined,
} = defineProps<{
    // The primary half's words, and the verb the picker's own commit bar wears: the panel a caret opens is
    // closed by a button saying the same thing the button beside it says.
    label: string;
    /* WHAT THIS RUN OPENS ON AND HOW TO RE-POINT IT, whole (useAgentRunPick). */
    picker: AgentRunPicker;
    /** Both halves' tier (Button's); a `quiet` pair trims its inner edges. */
    tier?: ButtonTier | undefined;
    tone?: ButtonTone | undefined;
    /** @deprecated `tier`/`tone`: what installed extensions built before tiers still pass. */
    severity?: string | undefined;
    size?: string;
    /** @deprecated `tier="quiet"`. */
    text?: boolean;
    icon?: IconName | undefined;
    loading?: boolean;
    disabled?: boolean;
    // The caller's own reason for the button, shown on the primary half; what the run costs is the caret's
    // own tooltip, so the two never share one. A booked press says when it starts instead.
    hint?: TooltipValue;
}>();
// The press. A caller whose picker reads `spent` sends `picker.booking` with it, so the run waits for the time drawn here.
const emit = defineEmits<{ run: [] }>();

// The caret's own DOM node, for the picker to anchor to; taken as the generic instance since PrimeVue's
// Button doesn't type `$el`.
const caret = ref<ComponentPublicInstance>();

const overridden = computed(() => picker.overridden.value);
// A named tier owns the look; with none, the legacy pair passes through to Button the way it always did.
const quiet = computed(() => (tier === undefined ? text : tier === `quiet`));
const look = computed(() => (tier === undefined && tone === undefined ? { severity, text } : { tier, tone }));
const modelLabel = computed(() => picker.model.value.label);

/* Model, tier, and rate stay together because they describe the click's cost. */
const spend = computed(() => {
    const choice = picker.model.value;
    return [
        choice.label,
        ...(choice.effortLabel === undefined ? [] : [choice.effortLabel]),
        ...(choice.fast === true ? [t(`ui.agentRunButton.fast`)] : []),
    ].join(` · `);
});

/* A SPENT ALLOWANCE MAKES THE PRESS A BOOKING (useAgentRunPick `spent`): the press then wears the time it starts, as the composer's Send does, and its tip says why. */
const booked = computed(() => picker.spent.value);
const pressLabel = computed(() => (booked.value === undefined ? label : t(`ui.agentRunButton.atTime`, { label, when: booked.value.short })));
const pressHint = computed((): TooltipValue | undefined => {
    const spent = booked.value;
    if (spent === undefined) {
        return hint;
    }
    return {
        title: t(`ui.agentRunButton.booked`),
        rows: [{ label: t(`ui.agentRunButton.starts`), value: spent.when }],
        note: t(`ui.agentRunButton.bookedNote`, { model: modelLabel.value }),
    };
});

/* WHAT THE CARET PROMISES, in the one place a caret can say anything: whose choice the run's model is, the model, and when it starts where that is not now. */
const caretHint = computed((): Tip => {
    const choice = picker.model.value;
    return {
        title: overridden.value ? t(`ui.agentRunButton.thisRunOnly`) : t(`ui.agentRunButton.sandboxDefault`),
        rows: [
            { label: t(`ui.agentRunButton.model`), value: choice.label },
            { label: t(`ui.agentRunButton.effort`), value: choice.effortLabel ?? `` },
            { label: t(`ui.agentRunButton.speed`), value: choice.fast === true ? t(`ui.agentRunButton.fast`) : `` },
            { label: t(`ui.agentRunButton.starts`), value: booked.value?.when ?? `` },
        ],
        note: overridden.value ? t(`ui.agentRunButton.clickToChange`) : t(`ui.agentRunButton.clickToConfigure`),
    };
});

/* ONE ACT: configure the run, and start it. `choose` answers true when the user pressed the panel's own button. */
const openPicker = (): void => {
    const el = caret.value?.$el as HTMLElement | undefined;
    if (el === undefined) {
        return;
    }
    void picker.choose(el, label).then((committed) => {
        if (committed) {
            emit(`run`);
        }
    });
};
</script>

<template>
    <span class="inline-flex items-stretch gap-px">
        <!-- Only borderless text buttons trim their inner edges. -->
        <!-- A booked press trades the caller's glyph for the clock: the time beside the verb is the press's whole meaning then. -->
        <Button
            :label="pressLabel"
            :size="size"
            v-bind="look"
            :loading="loading"
            :disabled="disabled"
            :class="['rounded-r-none', quiet ? 'pr-1' : '']"
            v-tooltip.top="pressHint"
            @click="emit(`run`)"
        >
            <template v-if="booked" #icon><Icon name="clock" /></template>
            <template v-else-if="icon" #icon><Icon :name="icon" /></template>
        </Button>
        <!-- Disabled together with the primary half, never on its own, so nobody can configure a model for a click that can't run. -->
        <!-- allow(buttons): A SPLIT BUTTON'S SEAM. Two buttons are welded into one control here, so the pair has to
             lose the corners and the padding where they meet, or it reads as two buttons that happen to be touching.
             This is the joint, not a tier being retuned: the tier is whatever the caller passed, and both halves take
             it. -->
        <Button
            ref="caret"
            :size="size"
            v-bind="look"
            :disabled="disabled || loading"
            :class="['rounded-l-none', quiet ? 'pl-1 pr-1.5' : 'px-1.5']"
            :aria-label="t(`ui.agentRunButton.configureStartRun`, { spend })"
            v-tooltip.top="caretHint"
            @click="openPicker"
        >
            <!-- The deviation spelled out where a bare chevron would be. -->
            <span class="flex items-center gap-1">
                <template v-if="overridden">
                    <Icon name="sparkles" class="shrink-0 text-2xs" />
                    <span class="max-w-[9rem] truncate text-2xs">{{ modelLabel }}</span>
                    <span v-if="picker.model.value.effortLabel !== undefined" class="shrink-0 text-2xs">· {{ picker.model.value.effortLabel }}</span>
                </template>
                <Icon name="chevron-down" class="shrink-0 text-2xs" />
            </span>
        </Button>
    </span>
</template>
