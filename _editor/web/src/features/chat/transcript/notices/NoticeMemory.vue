<script setup lang="ts">
import { SandboxResourcesDialog } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { engineMemoryGib, type ResourcesForm } from "@intentic/ui/sandbox-resources";
import { computed, ref } from "vue";
import { useSelfResources } from "../../../sandbox/devices/useSelfResources";
import type { ChatMessage } from "../transcript";
import NoticeHeld from "./NoticeHeld.vue";

/* A low-memory hold: the held message goes out as it is, or the sandbox's memory is raised first where this machine can reshape it. */

defineProps<{ message: ChatMessage }>();

const t = useT();
const selfResources = useSelfResources();

// GiB offered above the container's cap: enough for the gibibyte a turn must find free, short of handing over the machine.
const MEMORY_STEP_GIB = 4;
// The cap the form opens on, bounded by the engine's size; undefined when nothing is left to raise, or no cap to raise.
const suggestedGib = computed(() => {
    const bytes = selfResources.current.value?.memoryBytes;
    const now = bytes === undefined ? undefined : Math.floor(bytes / 1024 ** 3);
    const engine = engineMemoryGib(selfResources.engine.value);
    return now === undefined || engine === undefined || engine <= now ? undefined : Math.min(now + MEMORY_STEP_GIB, engine);
});
const offered = computed(() => selfResources.reshapable.value && suggestedGib.value !== undefined);

const resizing = ref(false);
const failed = ref<string | undefined>();
// The sandbox recreates under this page, so the reconnect is the answer; only a refusal the machine sent is a sentence.
const apply = async (shape: ResourcesForm): Promise<void> => {
    resizing.value = false;
    failed.value = undefined;
    await selfResources.apply(shape).catch((error: unknown) => {
        failed.value = error instanceof Error ? error.message : `That didn't work on this device.`;
    });
};
</script>

<template>
    <NoticeHeld :message="message">
        <template v-if="offered">
            <button
                type="button"
                class="shrink-0 font-medium text-link hover:underline"
                :disabled="selfResources.applying.value"
                @click="resizing = true"
            >
                {{ t(`chat.chatMessageView.raiseMemoryTo`, { gib: suggestedGib }) }}
            </button>
            <span class="shrink-0">{{ t(`chat.chatMessageView.sandboxRestartsMessageWaits`) }}</span>
            <SandboxResourcesDialog
                :open="resizing"
                :name="selfResources.slug.value ?? ``"
                :current="selfResources.current.value"
                :engine="selfResources.engine.value"
                :suggest-memory-gib="suggestedGib"
                :self-warning="true"
                @cancel="resizing = false"
                @apply="apply"
            />
        </template>
    </NoticeHeld>
    <span v-if="failed !== undefined" class="w-full text-warning">{{ failed }}</span>
</template>
