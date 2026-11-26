<script setup lang="ts">
import { Button, type IconName } from "@intentic/ui";
import { type RouteLocationRaw, RouterLink } from "vue-router";

// Shared answer control for decision cards (question Submit, permission Allow, a payment), the primary one last in its row (ChatCard). `tone` is visual weight,
// not agreement: a secondary button can still be the approval. Built on the design system's `<Button>`, so a
// promise-returning handler locks it until settled; `to` renders the answer as a link instead of a decision.

const { tone, icon, to } = defineProps<{
    // `quiet` for a refusal that only dismisses, so the one answer the card asks for is the one that stands out.
    tone: "primary" | "secondary" | "quiet";
    icon?: IconName;
    /** Renders this answer as a link to somewhere in the app, instead of as a button. */
    to?: RouteLocationRaw;
}>();
</script>

<template>
    <!-- Icon rides in the default slot, not PrimeVue's `#icon` one: a default slot replaces the whole button body. -->
    <Button :as="to === undefined ? undefined : RouterLink" :to="to" size="small" :tier="tone === `primary` ? `accent` : tone === `quiet` ? `quiet` : `boring`" thumb>
        <Icon v-if="icon" :name="icon" />
        <slot />
    </Button>
</template>
