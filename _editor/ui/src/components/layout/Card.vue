<!-- Surface card primitive. -->
<script setup lang="ts">
const { dashed = false } = defineProps<{ dashed?: boolean }>();
</script>

<template>
    <div class="ui-card" :class="{ 'ui-card-dashed': dashed }">
        <slot />
    </div>
</template>
