<!-- Surface card primitive. Replaces the repeated `rounded-xl border border-surface-700 bg-surface-900 p-4`
     literal; the styling lives in the `.ui-card` class (styles/shared/primeng.css). Set `dashed` for the
     empty-state look. -->
<script setup lang="ts">
const { dashed = false } = defineProps<{ dashed?: boolean }>();
</script>

<template>
    <div class="ui-card" :class="{ 'ui-card-dashed': dashed }">
        <slot />
    </div>
</template>
