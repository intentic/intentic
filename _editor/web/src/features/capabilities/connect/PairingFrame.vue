<script setup lang="ts">
import { Modal } from "@intentic/ui";

// Where a pairing step is shown: a dialog of its own, or (`inline`) under the row of the connection it pairs, where
// the row already names the connection, so only the instruction, the step and its last button are drawn. The step's
// own content is the same in both.

const { inline = false } = defineProps<{
    open: boolean;
    inline?: boolean;
    header: string;
    description?: string | undefined;
}>();

const emit = defineEmits<{ "update:open": [open: boolean] }>();
</script>

<template>
    <Modal v-if="!inline" :open="open" size="lg" :header="header" :description="description" @update:open="emit(`update:open`, $event)">
        <template v-if="$slots[`description`]" #description><slot name="description" /></template>
        <slot />
        <template #footer><slot name="footer" /></template>
    </Modal>
    <!-- `text-sm`: the dialog's body size, which the step's own content is written against. -->
    <section v-else-if="open" class="flex flex-col gap-3 text-sm" :aria-label="header">
        <p v-if="description !== undefined || $slots[`description`]" class="text-content">
            <slot name="description">{{ description }}</slot>
        </p>
        <slot />
        <div class="flex justify-end"><slot name="footer" /></div>
    </section>
</template>
