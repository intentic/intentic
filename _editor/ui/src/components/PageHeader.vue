<!-- The standard title block for every rail panel: one h1 with an optional inline info hint / status badge
     (#info), an optional right-aligned action cluster (#actions), and a muted description line. Unifies the
     hand-rolled <header> blocks that had drifted across mb-4/mb-5/mb-6 and disagreed on whether the info hint
     sat inline with the title. Sits inside a <Page>; the page owns width, the header owns nothing but its own
     rhythm.

     IT ALSO CARRIES THE WAY BACK, on the one form factor that has nowhere else to put it. See pageBack.ts: the
     mobile shell publishes an exit for every route that is not one of its four tabs, and this is the row that
     wears it — the title block is already at the top of every full-screen view, so the arrow costs no chrome,
     where a bar above the view would cost ~40px on every drill-in. Nothing is published on a desktop, so the
     arrow does not exist there. -->
<script setup lang="ts">
import { ui } from "../lib/ui.js";
import { usePageBack } from "./pageBack.js";

defineProps<{ title: string; description?: string }>();

const back = usePageBack();
</script>

<template>
    <header :class="description ? 'mb-6' : 'mb-4'">
        <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
                <!-- A button rather than a link: where it goes is history, not an address (see pageBack.ts),
                     and the shell decides between stepping back and falling home to the menu. Negative margin
                     so the arrow hangs in the page's gutter and the title still starts on the page's own left
                     edge — an h1 shunted 32px right on every hub is a worse trade than the arrow is a win. -->
                <button v-if="back" type="button" :class="ui.iconButton(`-ml-1.5 h-8 w-8 shrink-0`)" :aria-label="back.label" @click="back.go()">
                    <Icon name="arrow-left" class="text-base" />
                </button>
                <h1 class="min-w-0 truncate text-2xl font-semibold">{{ title }}</h1>
                <slot name="info" />
            </div>
            <div v-if="$slots['actions']" class="flex shrink-0 items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <p v-if="(description !== undefined && description !== ``) || $slots['description']" class="mt-1 text-sm text-muted">
            <slot name="description">{{ description }}</slot>
        </p>
    </header>
</template>
