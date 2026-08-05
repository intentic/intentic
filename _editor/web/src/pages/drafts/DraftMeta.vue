<!-- The muted line under a draft's brand mark: which platform it goes to, where on that platform, and one
     trailing note. It is deliberately the QUIET half of the row — the post's own words are the subject — and
     four sections of this page were each spelling it out identically before it was one component.

     IT TRUNCATES AS ONE LINE, not part by part. The first version made only the target shrinkable, on the
     reasoning that a target is the part that can be enormous (a subreddit is `r/webdev`; a reply draft carries
     the whole thread URL). On a phone that is exactly wrong: the target is then the only thing that CAN give,
     so it collapses to nothing — the line read "Discord · · proposed 1h ago" — while the note it was
     protecting kept its full width and ran under the Approve button beside it. One overflowing line with one
     ellipsis at the end degrades in the order the reader cares about: platform, then place, then when.

     The full line rides the tooltip whenever there is a target, since that is the piece worth recovering. The
     link deliberately carries no tooltip of its own — a tooltip inside a tooltipped element opens a second box
     on top of the first (see tooltip.ts, rule 5). -->
<script setup lang="ts">
import { computed } from "vue";

const { name, target, note } = defineProps<{
    /** The platform's display name — capitalized here, since an unknown platform arrives as its bare id. */
    name: string;
    target?: string;
    /** One trailing fact the section cares about ("proposed 3h ago"). */
    note?: string;
}>();

// A target that is somewhere to GO rather than a name to read: a reply draft carries its thread's URL, and a
// reviewer deciding whether the reply belongs under that thread needs to be able to open it.
const href = computed<string | undefined>(() => (target?.startsWith(`http`) === true ? target : undefined));
const full = computed<string | undefined>(() => (target === undefined ? undefined : [name, target, note].filter(Boolean).join(` · `)));
</script>

<template>
    <span class="block truncate" v-tooltip.top="full">
        <span class="capitalize">{{ name }}</span>
        <template v-if="target">
            <span class="text-subtle"> · </span>
            <a v-if="href" :href="href" target="_blank" rel="noopener" class="text-link hover:underline">{{ target }}</a>
            <template v-else>{{ target }}</template>
        </template>
        <template v-if="note"> <span class="text-subtle"> · </span>{{ note }} </template>
    </span>
</template>
