<script setup lang="ts">
import Button from "primevue/button";
import type { EnvironmentCheck } from "../desktop";

/* The probe result as a fix-it list. The parent owns fixing (sequencing, re-probing); this renders
 * state and forwards clicks. */
defineProps<{
    checks: EnvironmentCheck[];
    fixing: string | null;
}>();

const emit = defineEmits<{ fix: [id: EnvironmentCheck[`id`]] }>();
</script>

<template>
    <ul class="flex flex-col gap-2">
        <li v-for="check in checks" :key="check.id" class="flex items-start gap-3 rounded-xl border border-line bg-canvas px-3 py-2.5">
            <Icon
                :name="check.state === `ok` ? `check-circle` : check.state === `fixable` ? `wrench` : `warning`"
                :class="check.state === `ok` ? `text-success` : check.state === `fixable` ? `text-info` : `text-warning`"
                class="mt-0.5 shrink-0"
            />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-sm font-medium text-content">{{ check.title }}</span>
                <span v-if="check.detail" class="text-xs text-muted">{{ check.detail }}</span>
            </div>
            <Button
                v-if="check.state === `fixable`"
                size="small"
                :label="fixing === check.id ? `Fixing…` : `Fix`"
                :loading="fixing === check.id"
                :disabled="fixing !== null"
                @click="emit(`fix`, check.id)"
            />
        </li>
    </ul>
</template>
