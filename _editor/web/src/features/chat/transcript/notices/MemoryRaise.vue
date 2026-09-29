<script setup lang="ts">
import { SandboxResourcesDialog } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { engineMemoryGib, type ResourcesForm } from "@intentic/ui/sandbox-resources";
import { computed, ref } from "vue";
import { useSelfResources } from "../../../sandbox/devices/useSelfResources";

/* The other way past a low-memory hold, where this machine can reshape the sandbox: raise its memory first, while the held message waits through the restart. */

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
const apply = async (resources: ResourcesForm): Promise<void> => {
    resizing.value = false;
    failed.value = undefined;
    try {
        await selfResources.apply(resources);
    } catch (refusal) {
        failed.value = errorMessage(refusal, `That didn't work on this device.`);
    }
};
</script>

<template>
    <template v-if="offered">
        <button
            type="button"
            class="shrink-0 font-medium text-link hover:underline disabled:cursor-default disabled:text-subtle disabled:hover:no-underline"
            :disabled="selfResources.applying.value"
            v-tooltip.top="{ title: t(`chat.chatHeld.restartsSandbox`), note: t(`chat.chatHeld.messageWaits`) }"
            @click="resizing = true"
        >
            {{ t(`chat.chatHeld.raiseMemory`, { gib: suggestedGib }) }}
        </button>
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
    <span v-if="failed !== undefined" role="alert" class="w-full text-right text-warning">{{ failed }}</span>
</template>
