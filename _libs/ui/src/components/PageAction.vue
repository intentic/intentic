<!-- ONE ACTION IN A PAGE'S HEADER — and the only thing that belongs in <PageHeader #actions>.

     WHY THIS IS A COMPONENT AND NOT A CONVENTION. <PageHeader> unified the hand-rolled <header> blocks that had
     drifted across three margins, and the drift promptly reappeared one level down, inside the slot it opened:
     the button it holds was PrimeVue's raw <Button>, whose API is a matrix — label × #icon × seven severities ×
     text/outlined/rounded × three sizes — with nothing anywhere naming which cell of it a page action is. So
     every view re-decided. "Refresh this surface" reached six spellings, of which two sat one rail-click apart:
     a labelled bordered button on Acceptance and Live status, an icon-only borderless one on Maintenance.

     THE RULE IS TWO TIERS, AND WHICH ONE YOU GET IS DECIDED HERE, not at the call site:

       • A LABELLED BUTTON for an action that COMMITS something — New workflow, Generate, Start all, Add app.
         The header is where a page says what it can do, and a control that creates, starts or stops is worth
         the weight of a word. `primary` marks the page's single call to action, which is why it is a boolean
         and not a tone: a header with two primaries has no primary.

       • ITS ICON ALONE, borderless — `quiet`. For a VERB THE PAGE ALREADY IMPLIES, which in practice means
         Refresh and only Refresh: one per page, universally understood as the circular arrow, and doing
         nothing but re-reading what is already on screen. This tier was the first version's one real mistake:
         it unified the six refresh spellings correctly, then settled on the LOUD one, so every screen in the
         app grew the same grey pill out-weighing the h1 above it to announce that the page you are looking at
         can be reloaded. Ambient controls read as chrome or they compete with the title.

       • THE LABEL IS ALWAYS REQUIRED, in both tiers. It is the button's face in one and the tooltip and the
         accessible name in the other — a quiet action is drawn without words, never authored without them.

       • THE HINT IS THE WHY, never the what. `label` already says what the control does; `hint` carries what
         the label has no room for ("Re-read the evidence"). Through v-tooltip, so it looks like every other
         tooltip in the app and appears when a pointer expects it — the native `title` attribute this replaces
         was unstyled and a full second late.

     `href` renders the control as an anchor, and it is NOT quiet — a link is a destination, and a destination
     has to be named. `quiet` briefly applied to links too, and the pair it produced on Pipelines is the whole
     argument against it: two bare vendor glyphs, side by side, asking the reader to tell GitHub from GitLab by
     silhouette. There is no glyph at all for the thing a good outbound link actually points at ("this repo's
     pipelines", "Komodo's stacks"), which is the tell — an icon can carry a verb the reader already expects,
     never a place they have not been told about.

     And name a PLACE, not a product: the link belongs at the level of the view it leaves, not at its vendor's
     front door. A reader clicking out of a CI board wants that repo's pipelines; dropping them on github.com
     makes them navigate back down to where they already were. -->

<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { cmp } from "../cmp.js";
import Icon from "./Icon.vue";
import type { IconName } from "../icons/iconSets.js";

/* `quiet` and `href` are declared as an EITHER/OR rather than two independent booleans, so the rule above is
 * a compile error rather than a code review: a quiet link would render an icon that navigates nowhere, and a
 * named destination is the one thing the icon tier cannot carry. */
const { href, hint, label, quiet } = defineProps<
    {
        // What the action does, in the imperative. Required: see above.
        label: string;
        icon: IconName;
        // What the label has no room for. Absent is the common case — a self-explaining action earns no tooltip.
        hint?: string;
        disabled?: boolean;
    } & (
        | {
              // Draw the icon alone. For a verb the page already implies — see above.
              quiet?: boolean;
              // The page's ONE call to action. Everything else is secondary.
              primary?: boolean;
              href?: never;
          }
        // A header action that leaves the app. Opens in a new tab, because the page it leaves is the one the
        // user is working in.
        | { href: string; quiet?: never; primary?: never }
    )
>();

// With no visible label the tooltip carries both halves, because it is the only place either one is said.
const tooltip = computed(() => {
    if (quiet !== true) return hint;
    return hint === undefined ? label : `${label} — ${hint}`;
});
</script>

<template>
    <button
        v-if="quiet"
        type="button"
        :class="cmp.iconButton(`h-8 w-8 text-base disabled:pointer-events-none disabled:opacity-40`)"
        :disabled="disabled"
        :aria-label="label"
        v-tooltip.bottom="tooltip"
    >
        <Icon :name="icon" />
    </button>
    <Button
        v-else
        :label="label"
        size="small"
        :severity="primary ? undefined : `secondary`"
        :disabled="disabled"
        v-tooltip.bottom="tooltip"
        :as="href === undefined ? undefined : `a`"
        :href="href"
        :target="href === undefined ? undefined : `_blank`"
        :rel="href === undefined ? undefined : `noopener`"
    >
        <template #icon><Icon :name="icon" /></template>
    </Button>
</template>
