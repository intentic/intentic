<script setup lang="ts">
import { Button } from "@intentic/ui";
import { ref } from "vue";
import { useT } from "@intentic/ui/i18n";

// Delete, confirmed before it fires: the first press asks, the second deletes. It lives with the open skill, under its
// text, and is always the leftmost thing in that footer so it never sits beside Save.

const t = useT();

const { name, disabled = false } = defineProps<{ name: string; disabled?: boolean }>();
const emit = defineEmits<{ remove: [] }>();

const asking = ref(false);
</script>

<template>
    <Button
        v-if="!asking"
        size="small"
        tier="quiet"
        tone="danger"
        :label="t(`sandbox.skillRow.deleteSkill`)"
        :disabled="disabled"
        @click="asking = true"
    />
    <span v-else class="flex flex-wrap items-center gap-2">
        <span class="text-2xs text-muted">{{ t(`sandbox.skillRow.deleteAgentStopsBeing`, { name }) }}</span>
        <Button size="small" tone="danger" :label="t(`ui.action.delete`)" :disabled="disabled" @click="emit(`remove`)" />
        <Button size="small" tier="quiet" :label="t(`sandbox.skillRow.keep`)" @click="asking = false" />
    </span>
</template>
