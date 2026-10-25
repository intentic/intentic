<!-- THE BEACON: a small dot that says "this is the next thing to press", for a guided first run (a getting-started step,
     a coach mark's anchor). One on screen at a time is the rule its callers keep; two would each say "here" and neither
     would mean it. The ripple and its reduced-motion answer live in utilities.css (`.ui-beacon-ripple`), which follows the
     app's own motion setting (motion.css), so under reduced motion it stands still as a ringed dot rather than vanishing:
     the mark still has to be seen. It never takes
     the keyboard or a screen reader's attention: the control it sits on, or the button wrapping it, says what it is. -->
<script setup lang="ts">
const { size = `md` } = defineProps<{
    // `sm` sits on a rail tile's corner or a chip; `md` beside a heading or on a card.
    size?: `sm` | `md`;
}>();
</script>

<template>
    <!-- The root takes no position of its own, so a caller's placement (`absolute right-1 top-1` on a tile's corner) is
         the one that holds: a `relative` here beats a caller's `absolute`, since Tailwind emits `.relative` later, and
         drops the dot into the row's flow beside the control it marks. The ripple is placed against the inner box. -->
    <span class="pointer-events-none inline-flex shrink-0" :class="size === 'sm' ? 'size-2' : 'size-2.5'" aria-hidden="true">
        <span class="relative inline-flex size-full">
            <span class="absolute inset-0 rounded-full bg-primary-500 opacity-60 ui-beacon-ripple" />
            <span class="relative inline-flex size-full rounded-full bg-primary-500 ring-2 ring-canvas ui-beacon-dot" />
        </span>
    </span>
</template>
