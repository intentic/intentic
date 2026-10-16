<script setup lang="ts">
import { CopyButton, Row } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import PrivacyValueList from "./PrivacyValueList.vue";

// The values the shield leaves alone: your own company, a public figure, a word it keeps mistaking for a name. Kept in
// the one list editor the page uses for every list of values (PrivacyValueList), with a copy of the whole list beside it.

const t = useT();

const { allow, ready } = defineProps<{
    /** The list as saved, in the order it was added; undefined until the policy has been read. */
    allow: readonly string[] | undefined;
    ready: boolean;
}>();

// A change is handed up as a function of the list it lands on, so a write builds on the policy as it stands then.
const emit = defineEmits<{ write: [change: (allow: readonly string[]) => string[]] }>();

const values = computed(() => allow ?? []);

const labels = computed(() => ({
    field: t(`sandbox.agentPrivacyShield.neverMaskedField`),
    placeholder: t(`sandbox.agentPrivacyShield.neverMaskedPlaceholder`),
    empty: t(`sandbox.agentPrivacyShield.neverMaskedEmpty`),
    hint: t(`sandbox.agentPrivacyShield.neverMaskedHint`),
}));

// The whole list as one value per line: what a paste into this field, here or in another sandbox, takes back whole.
const asText = (): string => values.value.join(`\n`);
</script>

<template>
    <Row indent icon="check-circle" :title="t(`sandbox.agentPrivacyShield.neverMasked`)" :description="t(`sandbox.agentPrivacyShield.neverMaskedNote`)">
        <template v-if="values.length > 0" #meta>
            <span class="tabular-nums">{{ t(`sandbox.agentPrivacyShield.valuesCount`, { count: formatFixed(values.length, 0) }, values.length) }}</span>
        </template>
        <template v-if="values.length > 0" #control>
            <span v-tooltip.top="t(`sandbox.agentPrivacyShield.neverMaskedCopy`)"><CopyButton :text="asText" /></span>
        </template>
        <template #below>
            <PrivacyValueList :values="allow" :ready="ready" :labels="labels" @write="(change) => emit(`write`, change)" />
        </template>
    </Row>
</template>
