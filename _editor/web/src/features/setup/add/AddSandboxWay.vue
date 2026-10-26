<!-- ONE PLACE A NEW SANDBOX CAN RUN, as a row of the form's "Runs on" list (AddSandboxForm.vue): what it is (a machine's
     OS in its own colour, the cloud, this computer), its name, and the line that says what it is or does ("Windows 11 ·
     32 GiB · 16 cores", "In our cloud · 40 hours left this month"). A row on the dialog's ground rather than a pill or a
     boxed tile: the pick is the tint and the filled circle, as the share dialog's choices are. -->
<script setup lang="ts">
import { BrandMark } from "@intentic/ui";
import type { AddOption } from "./useAddSandbox";

const { option, on } = defineProps<{ option: AddOption; on: boolean }>();
const emit = defineEmits<{ pick: [] }>();
</script>

<template>
    <button
        type="button"
        role="radio"
        :aria-checked="on"
        :tabindex="on ? 0 : -1"
        class="ui-row-select flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left max-md:py-2.5"
        :class="{ 'ui-row-select-on': on }"
        :data-add-sandbox-way="option.value"
        @click="emit(`pick`)"
    >
        <BrandMark :size="28" :name="option.label" :icon="option.mark?.icon ?? option.icon" :tint="option.mark?.tint" />
        <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-sm font-medium text-content">{{ option.label }}</span>
            <span v-if="option.note" class="truncate text-xs text-muted">{{ option.note }}</span>
        </span>
        <Icon :name="on ? `check-circle` : `circle`" class="shrink-0 text-sm" :class="on ? `text-accent` : `text-subtle`" />
    </button>
</template>
