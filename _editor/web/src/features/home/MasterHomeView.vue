<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
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
import { homeEntryPath } from "../../models/sandbox/sandboxScreen";
const route = useRoute();
const router = useRouter();
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
// HOME'S BARE ADDRESS NAMES A SANDBOX BEFORE IT SHOWS ONE, on a desktop: the first screen, the Home command and a dialog
// closing back onto it (`/home`) become the sandbox open last, on the section chosen for every sandbox
// (lib/routes/homeSection.ts) or its home conversation, so the address says what the page shows and Back returns to it.
// Every other ask of Home (a dialog, a process's page, a view shown in place) is answered here as it always was; a phone
// keeps the bare address for its list of sandboxes. The sandbox an address names is selected by the router
// (router/shellGates.ts).
const sectionTarget = computed(() => {
    const id = sandbox.activeSandboxId.value;
    const bare = route.name === `home` && route.params[`sandbox`] === undefined && Object.keys(route.query).length === 0 && route.hash === ``;
    const offered = switchableSandboxes(sandbox.sandboxes.value).some((box) => box.id === id);
    return mobile.value || id === undefined || !bare || !offered ? undefined : homeEntryPath(id);
});
watch(
    sectionTarget,
    (target) => {
        if (target !== undefined) {
            void router.replace(target);
        }
    },
    { immediate: true },
);
</script>
<template>
    <div class="flex h-full min-h-0 overflow-hidden" data-home-view>
        <HomeSandboxes v-if="list" :phone="true" class="w-full" />
        <template v-else-if="sectionTarget === undefined">
            <HomeNewSandbox v-if="making" />
            <HomeProcess v-else-if="following" />
            <HomeChat v-show="!making && !following" :key="sandbox.activeSandboxId.value" />
            <NewSandboxDialog v-if="asking && newSandbox" :run="newSandbox" />
        </template>
    </div>
</template>
