<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import { useDevice } from "@intentic/ui";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import HomeSandboxes from "./HomeSandboxes.vue";
import HomeChat from "./HomeChat.vue";
import HomeProcess from "./HomeProcess.vue";
import { processAskedBy } from "../../models/processes/processAddress";
import HomeNewSandbox from "./newSandbox/HomeNewSandbox.vue";
import NewSandboxDialog from "./newSandbox/NewSandboxDialog.vue";
import { newSandbox, newSandboxDialogShown, newSandboxPageShown } from "./newSandbox/newSandbox";
const route = useRoute();
const { mobile } = useDevice();
const sandbox = useSandbox();
const list = computed(() => mobile.value && route.params[`sandbox`] === undefined);
// The new sandbox's dialog over the chat until its press went somewhere, then its run's page in the chat's place
// (newSandbox.ts); a phone adds through the shell's dialog instead. The chat stays mounted underneath, hidden, so going
// back to it finds its draft as it was.
const asking = computed(() => !mobile.value && newSandboxDialogShown(route, newSandbox.value));
const making = computed(() => !mobile.value && newSandboxPageShown(route, newSandbox.value));
// A process's page (sign-in, this PC's setup, a sandbox's) in the chat's place while its tile is selected (HomeProcess.vue).
const following = computed(() => !mobile.value && !making.value && processAskedBy(route) !== undefined);
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
        <template v-else>
            <HomeNewSandbox v-if="making" />
            <HomeProcess v-else-if="following" />
            <HomeChat v-show="!making && !following" :key="sandbox.activeSandboxId.value" />
            <NewSandboxDialog v-if="asking && newSandbox" :run="newSandbox" />
        </template>
    </div>
</template>
