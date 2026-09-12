<script setup lang="ts">
import { Button, type IconName } from "@intentic/ui";
import { type RouteLocationRaw, RouterLink } from "vue-router";

// Shared answer control for decision cards (plan Approve, question Submit, permission Allow). `tone` is visual weight,
// not agreement: a secondary button can still be the approval. Built on the design system's `<Button>`, so a
// promise-returning handler locks it until settled; `to` renders the answer as a link instead of a decision.

const { tone, icon, to } = defineProps<{
    tone: "primary" | "secondary";
    icon?: IconName;
    /** Renders this answer as a link to somewhere in the app, instead of as a button. */
    to?: RouteLocationRaw;
}>();
</script>

<template>
    <!-- Icon rides in the default slot, not PrimeVue's `#icon` one: a default slot replaces the whole button body. -->
    <Button
        :as="to === undefined ? undefined : RouterLink"
        :to="to"
        size="small"
        :severity="tone === `primary` ? undefined : `secondary`"
        class="ui-button-thumb"
    >
        <Icon v-if="icon" :name="icon" />
        <slot />
    </Button>
</template>
