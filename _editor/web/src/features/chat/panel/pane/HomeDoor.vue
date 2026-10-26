<!-- WHOSE HOME CHAT THIS IS, AND THE WAY INSIDE. Under the master view's composer (features/home/HomeChat.vue), the selected
     sandbox's name and one press that opens it where it was last left (sandboxEntryPath): the same step the rail tile's
     double-click and Enter take, said where it can be seen. A top bar over the chat carrying the same was removed by the
     owner's decision, so this is one quiet item of the status strip instead (ChatPaneStatus.vue decides when it shows).
     A link, so Ctrl/Cmd-click opens the sandbox in a tab of its own; a plain click steps inside past Home's rule. -->
<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { goInside } from "../../../../lib/routes/homeDetour";
import { sandboxEntryPath } from "../../../../models/sandbox/sandboxScreen";

const t = useT();
const router = useRouter();
const sandbox = useSandbox();
const name = computed(() => sandbox.active.value?.name ?? ``);
const path = computed(() => {
    const id = sandbox.activeSandboxId.value;
    return id === undefined ? undefined : sandboxEntryPath(id);
});
const href = computed(() => (path.value === undefined ? undefined : router.resolve(path.value).href));

const enter = (event: MouseEvent): void => {
    const to = path.value;
    if (to === undefined || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
        return;
    }
    event.preventDefault();
    void goInside(() => router.push(to));
};
</script>

<template>
    <a
        v-if="href !== undefined"
        :href="href"
        class="group touch-target inline-flex min-w-0 items-center gap-1 whitespace-nowrap transition-colors hover:text-content"
        :aria-label="t(`chat.homeDoor.openNamed`, { name })"
        data-home-door
        @click="enter"
    >
        <span class="shrink-0">{{ t(`chat.homeDoor.talkingTo`) }}</span>
        <span class="min-w-0 max-w-40 truncate font-medium text-muted group-hover:text-content">{{ name }}</span>
        <span class="shrink-0" aria-hidden="true">·</span>
        <span class="inline-flex shrink-0 items-center gap-0.5 text-muted group-hover:text-content"
            >{{ t(`chat.homeDoor.open`) }}<Icon name="arrow-right" class="text-2xs" aria-hidden="true"
        /></span>
    </a>
</template>
