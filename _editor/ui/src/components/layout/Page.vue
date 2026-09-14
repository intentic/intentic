<!-- Centered, width-constrained page shell. -->
<script setup lang="ts">
withDefaults(defineProps<{ width?: `content` | `wide` | `full` }>(), { width: `content` });
</script>

<template>
    <div class="ui-page" :data-width="width">
        <slot />
    </div>
</template>
