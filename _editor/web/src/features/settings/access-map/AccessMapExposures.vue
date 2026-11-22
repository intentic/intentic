<script setup lang="ts">
import { Button, Icon, toneFill } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type AccountGraph, type Exposure, YOU_ID } from "./accountGraph";
import { exposureWords } from "./accessMapWords";

// WHAT TO READ FIRST: each tie through which other people's agents, or a sandbox outside the account, can act on a
// computer, a server, another sandbox or the account itself. One sentence each, most serious first (accountGraph.ts
// orders them), and Show lights it on the map. Nothing here is wrong in itself; it is what an owner should know they
// granted.

const t = useT();

const { graph, showable = true } = defineProps<{
    graph: AccountGraph;
    /** Whether there is a drawing to light: the list in words has none, so it offers no Show. */
    showable?: boolean;
}>();
const emit = defineEmits<{ show: [id: string] }>();

const rows = computed(() => graph.exposures.map((exposure) => ({ key: `${exposure.kind}:${exposure.edge}`, words: exposureWords(graph, exposure), exposure })));

// What Show lights: what the reach lands on, or for the account itself, the sandbox it comes from.
const focusOf = (exposure: Exposure): string => (exposure.to === YOU_ID ? exposure.from : exposure.to);
</script>

<template>
    <section v-if="rows.length > 0" class="flex flex-col gap-1.5" :aria-label="t(`settings.accessMap.exposure.heading`)">
        <h3 class="text-xs font-medium text-muted">{{ t(`settings.accessMap.exposure.heading`) }}</h3>
        <ul class="flex flex-col gap-1">
            <li v-for="row in rows" :key="row.key" class="flex items-center gap-2 rounded-md px-3 py-1.5" :class="toneFill(`warning`, `soft`)">
                <Icon name="exclamation-triangle" class="shrink-0 text-xs text-warning" />
                <span class="min-w-0 flex-1 text-sm text-content">{{ row.words }}</span>
                <Button v-if="showable" size="small" tier="quiet" :label="t(`settings.accessMap.exposure.show`)" @click="emit(`show`, focusOf(row.exposure))" />
            </li>
        </ul>
    </section>
</template>
