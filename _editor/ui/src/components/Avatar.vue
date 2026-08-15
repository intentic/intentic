<!-- A person, in a circle — the one component for every face in the app: the presence roster, the member list,
     the account control, the profile form, a pipeline run's author.

     THE FALLBACK LADDER IS THE WHOLE POINT, and it was the thing nine hand-rolled copies disagreed about. A
     picture URL is the least reliable field the app holds: it comes from a vendor CDN, it can 404 long after
     the profile was written, and a referrer-stripped request can be refused outright. So `src` is a hope, not
     a fact, and every site needs the same three tiers behind it — picture, then initials, then a glyph. Copies
     that omitted the `error` handler (the mobile menu's, the member list's) rendered an EMPTY tinted circle
     the moment a URL went stale, which reads as a rendering bug rather than as a person.

     Initials are opt-in via `name`, not derived from whatever is around: the account control deliberately
     shows the neutral glyph rather than the signed-in user's own initials, because it is the button for "your
     account", not a depiction of you. Passing no name is how a caller says so.

     `hue` is IDENTITY COLOUR — the same person's hue on every surface, computed by the caller (the app owns
     the email→hue hash; this library has no business knowing what a member is). Passing none gives the neutral
     chrome the account/author avatars wear. The tinted-background variant one call site had grown is gone:
     colour here answers "who is this", and a member who is teal on the roster and pale-teal-on-white in the
     member list is answering it twice, differently.

     Size is a number of PIXELS rather than a scale, because the real sizes in use are 16, 24, 28, 32, 40 and
     56 and snapping them to a five-step scale would have moved four surfaces to make a prop look tidier. The
     initials track it (3/8 of the box, floored so the 16px chip stays legible), so one number sets both. -->
<script setup lang="ts">
import { computed } from "vue";
import { initialsOf } from "../lib/format.js";
import Icon from "./Icon.vue";

const {
    size,
    name,
    src,
    hue,
    idle = false,
    ring = 0,
} = defineProps<{
    size: number;
    /** Supplies the initials tier AND the accessible label. Omit for the neutral picture-or-glyph avatar. */
    name?: string;
    /* Nullable as well as optional, deliberately: "no picture" arrives as `null` from the platform's own user
     * record and as `undefined` from the daemon's presence roster, and making every caller launder one into
     * the other would put a `?? undefined` on half the avatars in the app to satisfy a type this component is
     * entirely relaxed about. Absent is absent — the fallback ladder is the same either way. */
    src?: string | null;
    /** HSL hue for the identity fill. Omitted ⇒ neutral surface + border, the account/author look. */
    hue?: number;
    /** All the member's tabs are hidden: dimmed and desaturated, never removed. */
    idle?: boolean;
    /** Hairline against the surface behind, for avatars that OVERLAP in a stack. 0 = none. */
    ring?: number;
}>();

// Shared with <BrandMark>: the monogram rule is the same whether the thing being drawn is a person or a
// product, and the two copies of it had already drifted apart once.
const initials = computed<string | undefined>(() => initialsOf(name ?? ``));

// A dead picture URL degrades to the tier underneath it. Hiding the <img> rather than clearing `src` keeps
// this a pure DOM effect — the caller's data is not ours to correct, and a re-render must not retry forever.
const hideBrokenImage = (event: Event): void => {
    (event.target as HTMLImageElement).style.display = `none`;
};
</script>

<template>
    <span
        class="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full transition-opacity"
        :class="[idle ? `opacity-50 grayscale` : ``, hue === undefined ? `border border-line bg-content/5 text-muted` : `text-white`]"
        :style="{
            width: `${size}px`,
            height: `${size}px`,
            fontSize: `${Math.max(7, size * 0.375)}px`,
            ...(hue === undefined ? {} : { backgroundColor: `hsl(${hue} 55% 42%)` }),
            ...(ring > 0 ? { boxShadow: `0 0 0 ${ring}px var(--color-card)` } : {}),
        }"
        :aria-label="name"
    >
        <span v-if="initials !== undefined" class="font-semibold leading-none">{{ initials }}</span>
        <Icon v-else name="user" />
        <!-- Over the fallback, not instead of it: the tier underneath is already painted, so a picture that
             fails to load reveals it rather than leaving a hole. no-referrer because an avatar host has no
             business learning which sandbox is looking at it. -->
        <img
            v-if="src !== undefined && src !== null"
            :src="src"
            alt=""
            referrerpolicy="no-referrer"
            class="absolute inset-0 h-full w-full object-cover"
            @error="hideBrokenImage"
        />
    </span>
</template>
