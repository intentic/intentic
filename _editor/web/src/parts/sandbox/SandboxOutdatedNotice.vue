<script setup lang="ts">
import { type CommandOs, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { RouterLink } from "vue-router";
import RunCommand from "../../components/RunCommand.vue";
import { useServingSlug } from "../../models/sandbox/environment/servingSlug";
import { useHostRunning } from "../../models/sandbox/devices/useDevices";
import { updateCommand } from "../../models/sandbox/environment/updateCommand";

// A SANDBOX TOO OLD FOR A VIEW: one calm note wherever a section is drawn from fields its daemon does not send yet (the
// persona a conversation speaks as now), in place of the guesses the editor used to rebuild from what an older daemon did
// send. What the view goes without is the caller's sentence. How to update is the same everywhere: the sandbox page,
// whose Update card is the one press for a hosted sandbox or one on a connected machine, or, for one installed by hand,
// the `update/<slug>` one-liner on the device that runs it (a desktop install reinstalls). The slug is named because a
// device running several sandboxes refuses the bare verb; `ic sandbox update` is offered only when this page cannot know it.
// The one-liner is left out when this sandbox reaches the device it runs on: the link is then to a press, not a recipe.

const t = useT();

defineProps<{
    // What this view shows once the sandbox updates, as one sentence.
    missing: string;
}>();

const slug = useServingSlug();
const command = (os: CommandOs): string => updateCommand(slug.value, os);
const reachable = useHostRunning(() => slug.value);
</script>

<template>
    <Notice tone="info" data-outdated class="text-xs">
        <span class="block font-medium">{{ t(`sandbox.sandboxOutdatedNotice.title`) }}</span>
        <span class="mt-0.5 block">{{ missing }}</span>
        <span class="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xs">
            <RouterLink to="/sandbox/overview" data-update class="font-medium text-link hover:underline">{{
                t(`sandbox.sandboxOutdatedNotice.update`)
            }}</RouterLink>
            <span v-if="!reachable" class="text-subtle">{{ t(`sandbox.sandboxOutdatedNotice.manual`) }}</span>
        </span>
        <RunCommand v-if="!reachable" class="mt-1.5" :command="command" />
    </Notice>
</template>
