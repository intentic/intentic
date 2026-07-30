<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";

/* Who triggered a run, at a glance. Three tiers, because the vendors give us different amounts: a real avatar
 * when we have a URL, the author's initials when we only have a name, and a generic glyph when we have
 * neither. The image is also allowed to fail at load time (a revoked gravatar, a 404'd vendor CDN) and falls
 * back to the same initials rather than a broken-image box. */

const { name, avatarUrl } = defineProps<{ name: string | undefined; avatarUrl: string | undefined }>();

const failed = ref(false);
const showImage = computed(() => avatarUrl !== undefined && !failed.value);

// "John Doe" → JD; a single-word handle like "radarsu" → RA. Uppercased, never more than two glyphs.
const initials = computed((): string | undefined => {
    const words = (name ?? ``).trim().split(/\s+/).filter((word) => word !== ``);
    const [first, second] = words;
    if (first === undefined) {
        return undefined;
    }
    return (second === undefined ? first.slice(0, 2) : `${first[0]}${second[0]}`).toUpperCase();
});
</script>

<template>
    <span
        class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-content/5 text-subtle"
        v-tooltip.top="name"
    >
        <!-- no-referrer: an avatar host has no business learning which sandbox is looking at it. -->
        <img
            v-if="showImage"
            :src="avatarUrl"
            alt=""
            referrerpolicy="no-referrer"
            class="h-full w-full object-cover"
            @error="failed = true"
        />
        <span v-else-if="initials" class="text-[9px] font-semibold leading-none">{{ initials }}</span>
        <Icon v-else name="user" class="text-2xs" />
    </span>
</template>
