<!-- ONE ACTION IN A PAGE'S HEADER — and the only thing that belongs in <PageHeader #actions>.

     WHY THIS IS A COMPONENT AND NOT A CONVENTION. <PageHeader> unified the hand-rolled <header> blocks that had
     drifted across three margins, and the drift promptly reappeared one level down, inside the slot it opened:
     the button it holds was PrimeVue's raw <Button>, whose API is a matrix — label × #icon × seven severities ×
     text/outlined/rounded × three sizes — with nothing anywhere naming which cell of it a page action is. So
     every view re-decided. "Refresh this surface" reached six spellings, of which two sat one rail-click apart:
     a labelled bordered button on Acceptance and Live status, an icon-only borderless one with a native `title`
     on Maintenance. Both authors were reasonable; neither had a rule to follow.

     THE RULE, now expressed as the only way to write one:

       • SMALL. A page header is a title, not a toolbar — its controls sit under an h1 and must not out-weigh it.
       • LABELLED, ALWAYS. This is the one place a page says what it does; an unlabelled glyph there is chrome in
         the position that should carry the most meaning. Icon-only affordances are the TOOLBAR tier and have
         their own recipe (cmp.iconButton) — reach for that inside a panel, never here.
       • SECONDARY BY DEFAULT. `primary` marks the page's single call to action (New workflow, Run all), which is
         why it is a boolean and not a tone: a header with two primaries has no primary.
       • THE HINT IS THE WHY, never the what. `label` already says what the control does; `hint` carries what the
         label has no room for ("Re-read the evidence"). Through v-tooltip, so it looks like every other tooltip
         in the app and appears when a pointer expects it — the native `title` attribute this replaces was
         unstyled and a full second late.

     `href` renders the same control as an anchor, for the header action that leaves the app (Open Komodo, Open
     GitHub). Those were two byte-identical hand-rolled <a> blocks reading as quiet text, which under-sold them:
     leaving for the deployment console is as much a page action as reloading the page is. -->
<script setup lang="ts">
import Button from "primevue/button";
import Icon from "./Icon.vue";
import type { IconName } from "../icons/iconSets.js";

const { href } = defineProps<{
    // What the action does, in the imperative. Required: see above.
    label: string;
    icon?: IconName;
    // The page's ONE call to action. Everything else is secondary.
    primary?: boolean;
    // What the label has no room for. Absent is the common case — a self-explaining action earns no tooltip.
    hint?: string;
    disabled?: boolean;
    // A header action that leaves the app. Opens in a new tab, because the page it leaves is the one the user
    // is working in.
    href?: string;
}>();
</script>

<template>
    <Button
        :label="label"
        size="small"
        :severity="primary ? undefined : `secondary`"
        :disabled="disabled"
        v-tooltip.bottom="hint"
        :as="href === undefined ? undefined : `a`"
        :href="href"
        :target="href === undefined ? undefined : `_blank`"
        :rel="href === undefined ? undefined : `noopener`"
    >
        <template v-if="icon" #icon><Icon :name="icon" /></template>
    </Button>
</template>
