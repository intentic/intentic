<script setup lang="ts">
import Button from "primevue/button";
import type { IconName } from "@intentic/ui";

/* The answer to a decision card — the plan's Approve, the question's Submit, the permission's Allow once, and
 * every No beside them. One component because the three cards ask the same shape of thing and must not drift:
 * a reader who has approved a plan should recognise the permission prompt's buttons as the same control.
 *
 * `tone` is WEIGHT, not agreement. The permission card's "Always allow …" is an approval wearing the secondary
 * tone, because the card's primary answer is the one-off allow and a second filled button beside it would make
 * the pair a coin flip. So: primary is the answer the card is asking for, secondary is everything else.
 *
 * `compact` is the question card's Submit/Dismiss, which sit inline with the option rows and the Other field and
 * would out-weigh them at full size. Desktop only — the touch targets below stay 2.75rem in every tone, since a
 * finger has the same width whatever the button is next to.
 *
 * IT IS THE APP'S BUTTON UNDERNEATH, which it did not used to be. This component drew itself on a bare <button>
 * with the accent tint's exact numbers typed out by hand — `border-primary-fill/20 bg-primary-fill/10
 * text-primary-fill hover:border-primary-fill/35 hover:bg-primary-fill/18` — the same four mixes the design
 * system paints every other action button with, in a second copy that nothing kept in step with the first. A
 * palette change would have moved every button in the app except the ones answering an agent, which are the most
 * consequential presses in it.
 *
 * WHAT STAYS HAND-WRITTEN IS ONLY THE TOUCH TARGET, and it is a deliberate exception rather than a leftover:
 * these buttons commit an agent to an action, so on a phone they get a full 44px regardless of which tone or
 * size the card called for. Everything else — the tint, the neutral fill, the radius, the two sizes — now comes
 * from the same place as the rest of the app. */

const { tone, icon, compact } = defineProps<{ tone: "primary" | "secondary"; icon?: IconName; compact?: boolean }>();
</script>

<template>
    <!-- The icon rides INSIDE the default slot rather than in PrimeVue's `#icon` one: a default slot replaces
         the button's whole body, icon slot included, so an icon placed there would silently never render. -->
    <Button
        :size="compact ? `small` : undefined"
        :severity="tone === `primary` ? undefined : `secondary`"
        class="font-semibold max-md:h-11 max-md:px-5"
    >
        <Icon v-if="icon" :name="icon" />
        <slot />
    </Button>
</template>
