<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import BridgeTokensCard from "./BridgeTokensCard.vue";
import DesktopSyncCard from "./DesktopSyncCard.vue";

/* The Sandbox hub's "Sync" tab. Arriving from the Workspace "Open in local editor" shortcut
 * (/sandbox/sync?enable=desktop-sync) flashes + scrolls the card into view. */

const route = useRoute();
const highlight = ref(false);

onMounted(() => {
    if (route.query[`enable`] === `desktop-sync`) {
        highlight.value = true;
        // Let the card render, then bring it into view.
        setTimeout(() => document.getElementById(`desktop-sync`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
    }
});
</script>

<template>
    <div class="flex flex-col gap-4">
        <DesktopSyncCard :highlight="highlight" />
        <BridgeTokensCard />
    </div>
</template>
