<!-- Whether a fire goes ahead by itself, waits for the owner, or waits a while first: the setting that matters most about work nobody watches. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { Icon, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import PropertyPopover from "./PropertyPopover.vue";
import PropertyRow from "./PropertyRow.vue";
import { EDITABLE_VALUE } from "./propertyLook";
import { useAutomationPatch } from "./useAutomationPatch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

type Gate = `own` | `ask` | `delay`;
// Approval wins over a hold when both are stored, as the daemon has it.
const gate = computed<Gate>(() =>
    props.automation.requireApproval === true ? `ask` : (props.automation.holdForSeconds ?? 0) > 0 ? `delay` : `own`,
);
const holdSeconds = computed(() => props.automation.holdForSeconds ?? 0);

const said = computed(() =>
    ({
        own: t(`gateProperty.own`),
        ask: t(`gateProperty.ask`),
        delay: t(`gateProperty.delay`, { seconds: holdSeconds.value }),
    })[gate.value],
);
// What sits between a fire and its run besides this, said under it: the check, and whether it fires only on a change.
const note = computed<string | undefined>(() => {
    if (props.automation.fireOn === `change`) {
        return t(`gateProperty.onlyOnChange`);
    }
    return props.automation.guard !== undefined || props.automation.source !== undefined ? t(`gateProperty.afterCheck`) : undefined;
});

const CHOICES = computed(() => [
    { value: `own` as const, title: t(`gateProperty.own`), note: t(`gateProperty.ownNote`) },
    { value: `ask` as const, title: t(`gateProperty.ask`), note: t(`gateProperty.askNote`) },
    { value: `delay` as const, title: t(`gateProperty.delayChoice`), note: t(`gateProperty.delayNote`) },
]);

const anchor = ref<HTMLElement>();
const open = ref(false);
const picked = ref<Gate>(`own`);
const seconds = ref(60);
const { patch, error, saving } = useAutomationPatch(computed(() => props.automation));

const begin = (): void => {
    picked.value = gate.value;
    seconds.value = holdSeconds.value > 0 ? holdSeconds.value : 60;
    error.value = undefined;
    open.value = true;
};

const save = async (): Promise<void> => {
    const saved = await patch((stored) => {
        const next = { ...stored };
        delete next.requireApproval;
        delete next.holdForSeconds;
        if (picked.value === `ask`) {
            next.requireApproval = true;
        } else if (picked.value === `delay`) {
            next.holdForSeconds = seconds.value;
        }
        return next;
    });
    if (saved) {
        open.value = false;
    }
};
</script>

<template>
    <PropertyRow :label="t(`gateProperty.label`)">
        <button ref="anchor" type="button" :class="EDITABLE_VALUE" :aria-label="t(`gateProperty.change`, { now: said })" @click="begin">
            <span class="text-sm text-content">{{ said }}</span>
            <span v-if="note" class="text-xs text-subtle">{{ note }}</span>
        </button>

        <PropertyPopover
            v-model="open"
            :anchor="anchor"
            :header="t(`gateProperty.label`)"
            :saving="saving"
            :error="error"
            :can-save="picked !== `delay` || seconds > 0"
            @save="save"
        >
            <div class="flex flex-col gap-1" role="radiogroup" :aria-label="t(`gateProperty.label`)">
                <button
                    v-for="choice in CHOICES"
                    :key="choice.value"
                    type="button"
                    role="radio"
                    :aria-checked="picked === choice.value"
                    class="flex items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-content/5"
                    @click="picked = choice.value"
                >
                    <Icon :name="picked === choice.value ? `check-circle` : `circle`" class="shrink-0 text-sm" :class="picked === choice.value ? `text-link` : `text-subtle`" />
                    <span class="flex min-w-0 flex-col">
                        <span class="text-sm text-content">{{ choice.title }}</span>
                        <span class="text-xs text-subtle">{{ choice.note }}</span>
                    </span>
                </button>
            </div>
            <label v-if="picked === `delay`" class="flex items-center gap-2 pl-9 text-xs text-muted">
                {{ t(`gateProperty.waitFor`) }}
                <input v-model.number="seconds" type="number" min="1" class="w-20" :class="ui.input()" />
                {{ t(`gateProperty.seconds`) }}
            </label>
        </PropertyPopover>
    </PropertyRow>
</template>
