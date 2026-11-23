<script setup lang="ts">
// THE MARK OF A SIGN-IN THAT IS MOVING, beside the line that says what is happening: whose it is (the provider's logo, or
// the machine a landing is waited for on) on a round plate, and how it moves. `turn` is work under way that ends by
// itself (the sandbox fetching the page, a grant being redeemed); `pulse` is a wait on somebody (the reader on the
// provider's page, a machine catching the landing). Both still under the reduced-motion choice, where the plate alone
// still says whose it is.
const { motion } = defineProps<{ motion: `turn` | `pulse` }>();
</script>

<template>
    <span class="relative flex size-10 shrink-0 items-center justify-center text-base text-content" aria-hidden="true">
        <span class="absolute inset-0 rounded-full border-2 border-line"></span>
        <span
            v-if="motion === `turn`"
            class="absolute inset-0 rounded-full border-2 border-transparent border-t-primary-500 motion-safe:animate-spin"
        ></span>
        <!-- A ring swelling out of the plate and fading, from a little inside it so it never reaches far past the mark. -->
        <span v-else class="absolute inset-1 rounded-full border-2 border-primary-500/60 motion-safe:animate-ping"></span>
        <slot />
    </span>
</template>
