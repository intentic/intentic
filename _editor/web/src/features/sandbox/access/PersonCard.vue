<script setup lang="ts">
import { Avatar } from "@intentic/ui";
import { computed, ref } from "vue";
import { identityHue } from "../../../lib/identityHue";

// ONE PERSON AS THE PEOPLE GROUP DRAWS THEM: a small avatar beside their address and one line about them. An address is
// what names a person here, and addresses run long, so it is laid out as a row rather than under a square face: the part
// before the `@` gives way first, with an ellipsis, and the domain stays whole, since the domain is what says whose
// account it is. The whole address stays in the text a screen reader reads, and is the card's hover when it was cut.

const {
    email,
    line,
    image,
    selected = false,
    pressable = false,
    flush = false,
    dot,
    avatar = 32,
} = defineProps<{
    email: string;
    // What they can do, and where their invite stands.
    line?: string | undefined;
    image?: string | undefined;
    selected?: boolean;
    // A card that opens its person's panel; the signed-in person's own card and the panel's header are not pressable.
    pressable?: boolean;
    // No padding of its own, for a card standing as the header of something that pads it already.
    flush?: boolean;
    // A dot on the avatar while their invite waits (`info`) or has run out (`danger`).
    dot?: `info` | `danger` | undefined;
    avatar?: number;
}>();
defineEmits<{ press: [] }>();

const at = computed(() => email.lastIndexOf(`@`));
const local = computed(() => (at.value <= 0 ? email : email.slice(0, at.value)));
const domain = computed(() => (at.value <= 0 ? `` : email.slice(at.value)));

// The whole address on hover only when the card had to cut it: measured as the pointer arrives, since what fits depends
// on how wide the pane is at that moment.
const address = ref<HTMLElement>();
const clipped = ref(false);
const measure = (): void => {
    clipped.value = [...(address.value?.children ?? [])].some((part) => part.scrollWidth > part.clientWidth);
};
</script>

<template>
    <component
        :is="pressable ? `button` : `div`"
        :type="pressable ? `button` : undefined"
        :aria-pressed="pressable ? selected : undefined"
        v-tooltip.bottom="clipped ? email : undefined"
        class="flex min-w-0 items-center gap-3 rounded-xl text-left"
        :class="[flush ? `` : `px-3 py-2.5`, pressable ? `ui-row-select` : ``, selected ? `ui-row-select-on` : ``]"
        @click="pressable && $emit(`press`)"
        @pointerenter="measure"
    >
        <span class="relative flex shrink-0">
            <Avatar :size="avatar" :name="email" :src="image" :hue="identityHue(email)" />
            <span
                v-if="dot !== undefined"
                class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-canvas"
                :class="dot === `danger` ? `bg-danger` : `bg-info`"
                aria-hidden="true"
            />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
            <span ref="address" class="flex min-w-0 items-baseline text-sm text-content">
                <span class="min-w-0 truncate font-medium">{{ local }}</span>
                <span class="max-w-[65%] shrink-0 truncate text-muted">{{ domain }}</span>
            </span>
            <span v-if="line" class="truncate text-xs text-subtle">{{ line }}</span>
        </span>
        <slot name="end" />
    </component>
</template>
