<!-- The environment's contents before they are read: its sections under their real headings, chips where chips go and the stock list as a line of names. -->
<script setup lang="ts">
import { Section } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// Drawn by both waits that stand for these sections: the overlay's (the card is not drawn until the overlay is read) and
// the contents' own. The headings are the groups' own fixed words; a sandbox in use has blocks added by hand and by a
// capability, and every sandbox has the stock list.
const t = useT();

const CHIPS = [
    [`useEnvironmentContents.addedWorkspace`, [`w-40`, `w-36`]],
    [`useEnvironmentContents.capabilities`, [`w-32`]],
] as const;
const STAPLES = [`w-28`, `w-24`, `w-20`, `w-24`, `w-28`, `w-16`, `w-20`, `w-32`];
</script>

<template>
    <div class="flex flex-col gap-6" aria-hidden="true">
        <Section v-for="[label, chips] in CHIPS" :key="label" :label="t(`sandbox.${label}`)">
            <div class="flex flex-wrap gap-2">
                <span v-for="(width, chip) in chips" :key="chip" class="skeleton block h-8 rounded-full" :class="width" />
            </div>
        </Section>
        <Section :label="t(`sandbox.useEnvironmentContents.comesEverySandbox`)">
            <div class="flex flex-wrap gap-x-4 gap-y-2">
                <span v-for="(width, index) in STAPLES" :key="index" class="flex h-[1lh] items-center text-xs"><span class="skeleton block h-3" :class="width" /></span>
            </div>
        </Section>
    </div>
</template>
