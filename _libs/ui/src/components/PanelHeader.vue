<!-- The header row INSIDE a bordered surface — the note reader's, the log viewer's, the activity timeline's.
     Sibling to <PageHeader>, and the distinction is load-bearing: PageHeader sits ABOVE a page and owns an h1
     and a description; this one is the first row of a panel, divided from the body by the panel's own hairline,
     and its title competes with a document rather than introducing one. Three views had written it by hand at
     three paddings (px-4 py-2.5, px-4 py-3, px-4 py-2) with three ideas of where the controls go.

     IT STACKS BEFORE IT SQUEEZES. At rail width a title and a five-control cluster on one row leave the name
     reading as "Fix…", and the name is the whole point of a header — so below `md` the controls drop to their
     own line and the title gets the width. That rule came from the note reader, which is the narrowest real
     instance of this and therefore the one that found the failure.

     #meta is the fact line under the title (a path, a size, an edited-at) — muted and small, so it can carry
     three facts without any of them competing with the name above. -->
<script setup lang="ts">
defineProps<{ title?: string; description?: string }>();
</script>

<template>
    <header class="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-2.5 md:flex-row md:items-start md:justify-between md:gap-3">
        <div class="min-w-0">
            <div class="flex min-w-0 items-center gap-2">
                <slot name="lead" />
                <h2 v-if="title !== undefined || $slots[`title`]" class="min-w-0 truncate text-sm font-medium text-content">
                    <slot name="title">{{ title }}</slot>
                </h2>
                <slot name="badges" />
            </div>
            <p v-if="description !== undefined || $slots[`description`]" class="mt-1 text-xs text-muted">
                <slot name="description">{{ description }}</slot>
            </p>
            <p v-if="$slots[`meta`]" class="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-subtle"><slot name="meta" /></p>
        </div>
        <div v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-1.5">
            <slot name="actions" />
        </div>
    </header>
</template>
