<!-- The muted line under an approval's mark: what it is (which platform, or that it is an action), where on
     that platform, whose name it acts under, and one trailing note. It is deliberately the QUIET half of the
     row: the post's own words, or the action's summary, are the subject, and four sections of this page were
     each spelling it out identically before it was one component.

     A PLACE, NOT AN ADDRESS. A reply's target is the URL of the thread it attaches to, and rendered in full
     that is 90 characters of slug in link colour: the loudest, least readable thing on the row, and it answers
     "which thread" no better than its own subreddit does. destinationOf (postText.ts) reduces it to the place
     and the relationship: "reply in r/ClaudeAI", and the address survives as the link and the tooltip, so the
     piece worth recovering is one hover or one click away. Targets that were already readable (`r/webdev`,
     `#releases`, `@ada@hachyderm.io`) are passed through untouched.

     IT TRUNCATES AS ONE LINE, not part by part. The first version made only the target shrinkable, on the
     reasoning that a target is the part that can be enormous. On a phone that is exactly wrong: the target is
     then the only thing that CAN give, so it collapses to nothing: the line read "Discord · · proposed 1h
     ago", while the note it was protecting kept its full width and ran under the Approve button beside it.
     One overflowing line with one ellipsis at the end degrades in the order the reader cares about: platform,
     then place, then when.

     The full line rides the tooltip whenever there is a target, since that is the piece worth recovering. The
     link deliberately carries no tooltip of its own: a tooltip inside a tooltipped element opens a second box
     on top of the first (see tooltip.ts, rule 5). -->
<script setup lang="ts">
import { computed } from "vue";
import { destinationOf } from "./postText";

const { name, target, actsAs, note } = defineProps<{
    /** The platform's display name, or "Action": capitalized here, since an unknown platform arrives as its bare id. */
    name: string;
    target?: string;
    /* WHOSE NAME IT ACTS UNDER (the item's `actsAs` persona), because the row it sits on carries an Approve
     * button and this is the one fact that button cannot be taken back on. Between the place and the time on
     * purpose: the reader wants where before who, and who before when. */
    actsAs?: string;
    /** One trailing fact the section cares about ("proposed 3h ago"). */
    note?: string;
}>();

const destination = computed(() => (target === undefined ? undefined : destinationOf(target)));
const full = computed<string | undefined>(() =>
    target === undefined ? undefined : [name, target, actsAs === undefined ? undefined : `as ${actsAs}`, note].filter(Boolean).join(` · `),
);
</script>

<template>
    <span class="block truncate" v-tooltip.top="full">
        <span class="capitalize">{{ name }}</span>
        <template v-if="destination">
            <span class="text-subtle"> · </span>
            <template v-if="destination.verb">{{ destination.verb }}&nbsp;</template>
            <a v-if="destination.href" :href="destination.href" target="_blank" rel="noopener" class="text-link hover:underline">
                {{ destination.label }}<Icon name="external-link" class="ml-1 text-2xs" />
            </a>
            <template v-else>{{ destination.label }}</template>
        </template>
        <template v-if="actsAs"> <span class="text-subtle"> · </span>as {{ actsAs }} </template>
        <template v-if="note"> <span class="text-subtle"> · </span>{{ note }} </template>
    </span>
</template>
