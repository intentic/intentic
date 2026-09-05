<!-- EVERYTHING A CARD SAYS RATHER THAN ASKS: the credential guide, what applying it does to the sandbox, and
     the card's own paragraph. One component because they are one job: reference material read WHILE the form
     is filled in, and because the form column is the wrong home for all three.

     It used to be only the guide that sat beside the form, and the other two were stacked INSIDE it: the
     effects panel between the last field and the submit, the paragraph under that. Two consequences, both
     visible on the cards people actually open. The form grew a scrollbar on any card with more than three
     fields: Docker, GitHub, both devices, so the submit button was below the fold on the one screen whose
     entire purpose is pressing it. And the right-hand column existed only for the cards whose catalog author
     had written a `guide`, which left the other half of the catalog rendering a 36rem column of form against
     36rem of empty page.

     Moving all three here fixes both at once, and the second fix is the one that matters: EVERY card has
     effects, so every card now has a second column. The layout stops being a fact about the copy someone
     happened to write and becomes a fact about the screen.

     ORDER IS BY WHEN IT IS NEEDED. The guide is read before the first keystroke (it is how you get the value
     the first field wants), the effects before the last click (they are what the click agrees to), and the
     card's paragraph is the aside that neither of those is: the caveat you want in view but never act on. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry, CapabilityEffect } from "@intentic-app/capability-catalog";
import CapabilityEffects from "./CapabilityEffects.vue";
import CredentialGuide from "./CredentialGuide.vue";

defineProps<{
    entry: CapabilityCatalogEntry;
    values: Record<string, string>;
    effects: readonly CapabilityEffect[];
}>();
</script>

<template>
    <div class="flex flex-col gap-3">
        <CredentialGuide v-if="entry.guide" :entry="entry" :values="values" />
        <CapabilityEffects :effects="effects" />
        <!-- Unboxed, unlike the two panels above it. It is prose about the card rather than a list of facts
             about the sandbox, and a third bordered box here turns a column of reference into a stack of
             equally-weighted cards with nothing telling the reader which one to read first. -->
        <p v-if="entry.hint" class="px-1 text-xs leading-relaxed text-muted">{{ entry.hint }}</p>
    </div>
</template>
