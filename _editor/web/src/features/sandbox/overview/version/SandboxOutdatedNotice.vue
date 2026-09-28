<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useServingSlug } from "../../environment/servingSlug";

// A SANDBOX TOO OLD FOR A VIEW: one calm note wherever a section is drawn from fields its daemon does not send yet (the
// persona a conversation speaks as now), in place of the guesses the editor used to rebuild from what an older daemon did
// send. What the view goes without is the caller's sentence. How to update is the same everywhere: the sandbox page,
// whose Update card is the one press for a hosted sandbox or one on a connected machine, or, for one installed by hand,
// `ic sandbox update <slug>` on the machine that runs it (a desktop install reinstalls). The slug is named because a
// machine running several sandboxes refuses the bare verb; it is left off only when this page cannot know it.

const t = useT();

defineProps<{
    // What this view shows once the sandbox updates, as one sentence.
    missing: string;
}>();

const slug = useServingSlug();
const command = computed(() => (slug.value === undefined ? `ic sandbox update` : `ic sandbox update ${slug.value}`));
</script>

<template>
    <Notice tone="info" data-outdated class="text-xs">
        <span class="block font-medium">{{ t(`sandbox.sandboxOutdatedNotice.title`) }}</span>
        <span class="mt-0.5 block">{{ missing }}</span>
        <span class="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xs">
            <RouterLink to="/sandbox/overview" data-update class="font-medium text-link hover:underline">{{
                t(`sandbox.sandboxOutdatedNotice.update`)
            }}</RouterLink>
            <span class="text-subtle">
                {{ t(`sandbox.sandboxOutdatedNotice.manual`) }}
                <code class="font-mono">{{ command }}</code>
            </span>
        </span>
    </Notice>
</template>
