<script setup lang="ts">
/* HOW A MODULE IS SAID — in every list that groups changed files under one. There are two of those (the
 * workspace's Changes panel and the fleet's agent review) and each used to spell this out itself, which is how
 * a shared reading turns into two readings that almost match.
 *
 * `box` is a package that owns a manifest; `folder` is the fallback bucket named after the repo, for paths no
 * package claims. The glyph is drawn under 1em on purpose: at 1em these icon sets overshoot an 11px line's cap
 * height by ~1.5px top AND bottom, and a mark taller than the word beside it reads as sitting off-centre
 * however exactly it is centred.
 *
 * QUIETER THAN WHAT IT GROUPS. This is a heading over filenames, and filenames are what both panels are read
 * for: at `text-content` it outshone every row below it and the eye landed on the package instead of on the
 * change. `text-muted` plus the leading glyph is enough to read as a heading, and the separation does the rest.
 */
defineProps<{ name: string; packaged: boolean }>();
</script>

<template>
    <span class="flex min-w-0 items-center gap-1.5">
        <Icon :name="packaged ? 'box' : 'folder'" class="shrink-0 text-[0.6rem] text-subtle" />
        <span class="min-w-0 truncate text-2xs font-medium text-muted" v-tooltip.right.overflow="name">{{ name }}</span>
    </span>
</template>
