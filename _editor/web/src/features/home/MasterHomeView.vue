<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import { useDevice } from "@intentic/ui";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import HomeSandboxes from "./HomeSandboxes.vue";
import HomeChat from "./HomeChat.vue";
const route = useRoute();
const { mobile } = useDevice();
const sandbox = useSandbox();
const list = computed(() => mobile.value && route.params[`sandbox`] === undefined);
watch(
    () => [route.params[`sandbox`], sandbox.sandboxes.value] as const,
    ([id, boxes]) => {
        // Only a sandbox the rail offers: a link naming an unfinished setup must not make it the active one.
        const selected = switchableSandboxes(boxes).find((box) => box.id === id);
        if (selected !== undefined && sandbox.activeSandboxId.value !== selected.id) {
            sandbox.select(selected.id);
        }
    },
    { immediate: true },
);
</script>
<template>
    <div class="flex h-full min-h-0 overflow-hidden" data-home-view>
        <HomeSandboxes v-if="list" :phone="true" class="w-full" />
        <HomeChat v-else :key="sandbox.activeSandboxId.value" />
    </div>
</template>
