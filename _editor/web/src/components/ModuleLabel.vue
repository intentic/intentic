<script setup lang="ts">
// Module heading for grouped file lists (Changes panel, agent review). `box` is a package with a manifest;
// `folder` is the fallback for paths no package claims. Kept muted so it doesn't outshine the filenames it groups.
defineProps<{ name: string; packaged: boolean }>();
</script>

<template>
    <span class="flex min-w-0 items-center gap-1.5">
        <!-- A 10px slot, the Changes list's leading-glyph column (ReviewPanel's LEAD), so the box sits on the line its
             heading's label starts on and its files' status letters sit on the line its own name starts on. -->
        <span class="flex w-2.5 shrink-0 items-center justify-center">
            <Icon :name="packaged ? 'box' : 'folder'" class="text-[0.6rem] text-subtle" />
        </span>
        <span class="min-w-0 truncate text-2xs font-medium text-muted" v-tooltip.right.overflow="name">{{ name }}</span>
    </span>
</template>
