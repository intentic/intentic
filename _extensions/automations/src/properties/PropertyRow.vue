<!-- One fact about an automation, as a pair: what it is on the left, quiet, and its value on the right, where it is changed. -->
<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
    <div class="flex min-w-0 items-start gap-3">
        <dt class="w-24 shrink-0 py-1 text-xs text-subtle">{{ label }}</dt>
        <dd class="flex min-w-0 flex-1 flex-col"><slot /></dd>
    </div>
</template>
