<!--
    A person, in a circle: one avatar for every face in the app (roster, member list, account control, profile, pipeline author). Fallback ladder:
    picture, then initials (opt-in via `name`), then a neutral glyph. `hue` sets identity colour, computed by the caller; size is pixels, not a scale
    tier.
-->
<script setup lang="ts">
import { computed } from "vue";
import { initialsOf } from "../../lib/format.js";
import Icon from "../primitives/Icon.vue";

const {
    size,
    name,
    src,
    hue,
    idle = false,
    ring = 0,
} = defineProps<{
    size: number;
    /** Supplies the initials tier and the accessible label; omit for the neutral picture-or-glyph avatar. */
    name?: string;
    // Nullable and optional: `null` (platform record) or `undefined` (daemon roster) both just mean no picture.
    src?: string | null;
    /** HSL hue for the identity fill. Omitted ⇒ neutral surface + border, the account/author look. */
    hue?: number;
    /** All the member's tabs are hidden: dimmed and desaturated, never removed. */
    idle?: boolean;
    /** Hairline against the surface behind, for avatars that overlap in a stack; 0 = none. */
    ring?: number;
}>();

// Shared with <BrandMark>: same monogram rule whether drawing a person or a product.
const initials = computed<string | undefined>(() => initialsOf(name ?? ``));

// Hides the <img> rather than clearing `src`, so a dead picture reveals the tier beneath without retrying on
// re-render.
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
        <!--
            Layered over the fallback tier, so a failed load reveals it rather than leaving a hole. no-referrer: an
            avatar
            host shouldn't learn which sandbox is looking.
        -->
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
