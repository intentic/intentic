<!-- Which model an automation's new agents run on and how hard it thinks: the model by its catalog name and the composer's own effort rungs, re-picked with the shell's own picker. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { ModelPinSchema } from "@intentic/sandbox-contract/schemas/agent";
import { computed, ref } from "vue";
import { host } from "../host";
import EffortRungs from "./EffortRungs.vue";
import PropertyRow from "./PropertyRow.vue";
import { EDITABLE_VALUE } from "./propertyLook";
import { useAutomationPatch } from "./useAutomationPatch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

// The model it wants first. The ones it may fall back to are the editor's business: what a reader scans for is which
// model, and a fallback list read at every glance says nothing until the first one is spent.
const head = computed(() => props.automation.models?.[0]);
// The shell names it, so this reads "Opus 5.5" wherever the composer does, and says where the tier sits on the model's
// own ladder (PickedModel.effortRung).
const described = computed(() => (head.value === undefined ? undefined : host().models.describe({ ...head.value, account: props.automation.account })));

const anchor = ref<HTMLElement>();
const { patch, error } = useAutomationPatch(computed(() => props.automation));

// The shell's own picker over this value, opened on what is stored (or, for none, what a new automation would start
// on), so the model, its tier and its account are chosen the one way they are chosen everywhere.
const choose = async (): Promise<void> => {
    const element = anchor.value;
    if (element === undefined) {
        return;
    }
    const start = head.value ?? host().models.agentRun(`automation`);
    const picked = await host().models.pick({
        anchor: element,
        provider: start.provider,
        model: start.model,
        effort: start.effort,
        thinking: start.thinking,
        fast: start.fast,
        harness: start.harness,
        account: props.automation.account,
        chooseRun: true,
        action: t(`modelProperty.use`),
    });
    if (picked === undefined) {
        return;
    }
    // Parsed rather than assumed: the picker speaks for every connected provider, and a pin names only the ones an
    // automation can be woken on.
    const pin = ModelPinSchema.safeParse({
        provider: picked.provider,
        model: picked.model,
        effort: picked.effort,
        thinking: picked.thinking,
        fast: picked.fast,
        harness: picked.harness,
    });
    if (!pin.success) {
        error.value = t(`modelProperty.cannotRunOn`, { model: picked.label });
        return;
    }
    await patch((stored) => {
        const next = { ...stored, models: [pin.data, ...(stored.models ?? []).slice(1)] };
        if (picked.account === undefined) {
            delete next.account;
        } else {
            next.account = picked.account;
        }
        return next;
    });
};
</script>

<template>
    <PropertyRow :label="t(`modelProperty.model`)">
        <button ref="anchor" type="button" :class="EDITABLE_VALUE" :aria-label="t(`modelProperty.change`, { now: described?.label ?? `` })" @click="choose">
            <span v-if="described" class="flex min-w-0 items-center gap-2 text-sm text-content">
                <span class="min-w-0 truncate">{{ described.label }}</span>
                <!-- The tier as rungs, its name on hover: the picture is what the composer taught, the word is for whoever asks. -->
                <span
                    v-if="described.effortRung !== undefined && described.effortRungs !== undefined"
                    v-tooltip.top="described.effortLabel"
                    :aria-label="described.effortLabel"
                >
                    <EffortRungs :rung="described.effortRung" :rungs="described.effortRungs" />
                </span>
                <span v-else-if="described.effortLabel" class="text-xs text-subtle">{{ described.effortLabel }}</span>
            </span>
            <span v-else class="text-sm text-subtle">{{ t(`modelProperty.none`) }}</span>
            <span v-if="described?.accountLabel" class="text-xs text-subtle">{{ described.accountLabel }}</span>
        </button>
        <span v-if="error" class="text-xs break-words text-danger">{{ error }}</span>
    </PropertyRow>
</template>
