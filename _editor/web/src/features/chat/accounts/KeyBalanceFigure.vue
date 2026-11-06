<!-- What is left on one API key, where its vendor says (models/conversations/accounts/keyBalance.ts): the figure a key's row carries
     where an account's row carries its ring. Nothing at all where the vendor tells the key nothing. -->
<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { computed } from "vue";
import { formatAmount } from "@intentic/ui/format";
import { balanceLow, balanceTip, useKeyBalance } from "../../../models/conversations/accounts/keyBalance";

const { provider } = defineProps<{ provider: AgentProvider }>();

const { balance } = useKeyBalance(() => provider);
const figure = computed(() => {
    const read = balance.value;
    return read === undefined ? undefined : { amount: formatAmount(read.remaining, read.currency), low: balanceLow(read), tip: balanceTip(provider, read) };
});
</script>

<template>
    <span v-if="figure" class="ml-auto shrink-0 text-2xs tabular-nums" :class="figure.low ? `text-warning` : `text-subtle`" v-tooltip.top="figure.tip">
        {{ figure.amount }}
    </span>
</template>
