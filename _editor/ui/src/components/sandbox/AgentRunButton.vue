<script setup lang="ts">
import Button from "../primitives/Button.vue";
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
    severity?: string | undefined;
    size?: string;
    text?: boolean;
    icon?: IconName | undefined;
    loading?: boolean;
    disabled?: boolean;
    // The caller's own reason for the button, shown on the primary half; what the run costs is the caret's
    // own tooltip, so the two never share one.
    hint?: TooltipValue;
}>();
const emit = defineEmits<{ run: [] }>();

// The caret's own DOM node, for the picker to anchor to; taken as the generic instance since PrimeVue's
// Button doesn't type `$el`.
const caret = ref<ComponentPublicInstance>();

const overridden = computed(() => picker.overridden.value);
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

/* WHAT THE CARET PROMISES, in the one place a caret can say anything: whose choice the run's model is, and the model. */
const caretHint = computed((): Tip => {
    const choice = picker.model.value;
    return {
        title: overridden.value ? t(`ui.agentRunButton.thisRunOnly`) : t(`ui.agentRunButton.sandboxDefault`),
        rows: [
            { label: t(`ui.agentRunButton.model`), value: choice.label },
            { label: t(`ui.agentRunButton.effort`), value: choice.effortLabel ?? `` },
            { label: t(`ui.agentRunButton.speed`), value: choice.fast === true ? t(`ui.agentRunButton.fast`) : `` },
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
        <Button
            :label="label"
            :size="size"
            :severity="severity"
            :text="text"
            :loading="loading"
            :disabled="disabled"
            :class="['rounded-r-none', text ? 'pr-1' : '']"
            v-tooltip.top="hint"
            @click="emit(`run`)"
        >
            <template v-if="icon" #icon><Icon :name="icon" /></template>
        </Button>
        <!-- Disabled together with the primary half, never on its own, so nobody can configure a model for a click that can't run. -->
        <Button
            ref="caret"
            :size="size"
            :severity="severity"
            :text="text"
            :disabled="disabled || loading"
            :class="['rounded-l-none', text ? 'pl-1 pr-1.5' : 'px-1.5']"
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
