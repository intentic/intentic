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

       • ITS ICON ALONE, borderless, for an action that commits NOTHING — `quiet`. Refresh only re-reads what
         is already on screen; `href` only leaves for another surface. This tier was the first version's one
         real mistake: unifying the six refresh spellings correctly, then settling on the LOUD one, so every
         screen in the app grew the same grey pill out-weighing the h1 above it to announce that the page you
         are looking at can be reloaded. Ambient controls read as chrome or they compete with the title.

       • THE LABEL IS ALWAYS REQUIRED, in both tiers. It is the button's face in one and the tooltip and the
         accessible name in the other — a quiet action is drawn without words, never authored without them.

       • THE HINT IS THE WHY, never the what. `label` already says what the control does; `hint` carries what
         the label has no room for ("Re-read the evidence"). Through v-tooltip, so it looks like every other
         tooltip in the app and appears when a pointer expects it — the native `title` attribute this replaces
         was unstyled and a full second late.

     `href` renders the control as an anchor, and is quiet by definition: leaving for the deployment console is
     not something a page has to shout. Give it the icon of WHERE IT GOES rather than a generic arrow — two
     outbound links in one header (Open GitHub, Open GitLab) are told apart by their glyph or not at all. -->
<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { cmp } from "../cmp.js";
import Icon from "./Icon.vue";
import type { IconName } from "../icons/iconSets.js";

const { href, hint, label, quiet } = defineProps<{
    // What the action does, in the imperative. Required: see above.
    label: string;
    icon: IconName;
    // The page's ONE call to action. Everything else is secondary.
    primary?: boolean;
    // Draw the icon alone. For a control that re-reads rather than changes — see above.
    quiet?: boolean;
    // What the label has no room for. Absent is the common case — a self-explaining action earns no tooltip.
    hint?: string;
    disabled?: boolean;
    // A header action that leaves the app. Opens in a new tab, because the page it leaves is the one the user
    // is working in.
    href?: string;
}>();

const iconOnly = computed(() => quiet === true || href !== undefined);
// With no visible label the tooltip carries both halves, because it is the only place either one is said.
const tooltip = computed(() => {
    if (!iconOnly.value) return hint;
    return hint === undefined ? label : `${label} — ${hint}`;
});
</script>

<template>
    <component
        :is="href === undefined ? `button` : `a`"
        v-if="iconOnly"
        :type="href === undefined ? `button` : undefined"
        :class="cmp.iconButton(`h-8 w-8 text-base disabled:pointer-events-none disabled:opacity-40`)"
        :disabled="disabled"
        :aria-label="label"
        v-tooltip.bottom="tooltip"
        :href="href"
        :target="href === undefined ? undefined : `_blank`"
        :rel="href === undefined ? undefined : `noopener`"
    >
        <Icon :name="icon" />
    </component>
    <Button v-else :label="label" size="small" :severity="primary ? undefined : `secondary`" :disabled="disabled" v-tooltip.bottom="tooltip">
        <template #icon><Icon :name="icon" /></template>
    </Button>
</template>
