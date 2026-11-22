<script setup lang="ts">
import { computed } from "vue";
import type { AccountGraph } from "./accountGraph";
import { tieDetails, tieHead, tieWho } from "./accessMapWords";
import { tiesOf } from "./ties";

// ONE THING'S TIES IN WORDS: "Reaches rog — run commands, see the screen · 2 other people's agents can too". The map's
// caption says them for its focus, and the list says them for every sandbox and every machine, so what a line means is
// never left to the drawing alone.

const { graph, id } = defineProps<{ graph: AccountGraph; id: string }>();

const rows = computed(() =>
    tiesOf(graph, id).map((tie) => ({
        key: `${tie.verb}:${tie.edge.id}`,
        head: tieHead(graph, tie),
        details: tieDetails(tie.edge).join(`, `),
        who: tieWho(tie.edge, tie.verb).join(` · `),
        broken: tie.edge.answer === `revoked`,
    })),
);
</script>

<template>
    <ul v-if="rows.length > 0" class="flex min-w-0 flex-col gap-1">
        <li v-for="row in rows" :key="row.key" class="min-w-0 text-sm leading-snug">
            <span :class="row.broken ? `text-muted line-through` : `text-content`">{{ row.head }}</span>
            <span v-if="row.details !== ``" class="text-muted"> — {{ row.details }}</span>
            <span v-if="row.who !== ``" class="text-subtle"> · {{ row.who }}</span>
        </li>
    </ul>
</template>
