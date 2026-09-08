<script setup lang="ts">
// Module heading for grouped file lists (Changes panel, agent review). `box` is a package with a manifest;
// `folder` is the fallback for paths no package claims. Kept muted so it doesn't outshine the filenames it groups.
defineProps<{ name: string; packaged: boolean }>();
</script>

<template>
    <span class="flex min-w-0 items-center gap-1.5">
        <Icon :name="packaged ? 'box' : 'folder'" class="shrink-0 text-[0.6rem] text-subtle" />
        <span class="min-w-0 truncate text-2xs font-medium text-muted" v-tooltip.right.overflow="name">{{ name }}</span>
    </span>
</template>
