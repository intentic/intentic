<script setup lang="ts">
// The filter's own empty state, not the board's: agents exist, just none matched. It quotes the query as it was matched,
// spaces at the ends kept so a stray one shows inside the quotes, and offers a way out of each rule that narrowed it.
import { searchTermOf } from "@intentic/sandbox-contract/schemas/agent-search";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

const t = useT();
const query = defineModel<string>("query", { required: true });
const matchCase = defineModel<boolean>("matchCase", { required: true });
const asked = computed(() => searchTermOf(query.value));
const link = `font-medium text-link underline-offset-2 hover:underline`;
</script>

<template>
    <p class="px-4 pb-6 text-center text-2xs text-subtle">
        <template v-if="matchCase">
            {{ t(`agents.agentsView.noAgentMentions`) }}{{ asked }}{{ t(`agents.agentsView.thoseExactCapitals`) }}
            <button type="button" :class="link" @click="matchCase = false">{{ t(`agents.agentsView.ignoreCase`) }}</button>
        </template>
        <template v-else>{{ t(`agents.agentsView.noAgentYoursMentions`, { trim: asked }) }}</template>
        <button v-if="asked !== asked.trim()" type="button" class="ml-1" :class="link" @click="query = query.trim()">
            {{ t(`agents.agentsView.ignoreOuterSpaces`) }}
        </button>
    </p>
</template>
