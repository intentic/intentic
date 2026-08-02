<script setup lang="ts">
import { Code, commandLang, Segmented, useOsPreference } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed } from "vue";
import { DESKTOP_DOWNLOADS, desktopRecreateLink, desktopVersion, openDesktopLink } from "../environments/desktop";
import { bashCommand, psCommand } from "../environments/scriptCommand";

/* RECREATING THE SANDBOX — the one thing the browser genuinely cannot do for you.
 *
 * The daemon holds no HOST Docker socket (its own engine is nested), so it can never recreate its own
 * container. Both moments that need one — an update to a newer image, and building an owner-approved
 * environment overlay — therefore end here, on the machine the container runs on. Two cards used to state
 * that separately and hand out a bash-only one-liner each; this is the one place that says it.
 *
 * Three renderings of the same operation, in the order of how little work they ask for:
 *   • inside the desktop app — a button, because the app IS a process on that machine (intentic://recreate)
 *   • in a browser on Windows/Linux/macOS — the command, for the shell that machine actually has
 *   • in a browser with no app — the same command, plus where to get the app so the next one is a button
 *
 * The mode rides the ARGUMENT SHAPE, not a flag, exactly as recreate.sh has always read it: a hash means
 * "build the approved overlay pinned to this digest", no hash means "pull the fresh :stable base". */

const props = defineProps<{
    slug: string;
    /// The approved overlay's sha256 — present for a rebuild, absent for an update.
    hash?: string;
    /// What the button says. The command block is labelled from the same word.
    action: `Update` | `Rebuild`;
}>();

const { cmdOs } = useOsPreference();
const desktop = computed(() => desktopVersion() !== undefined);

const command = computed(() => {
    const key = props.hash === undefined ? `update` : `rebuild`;
    if (cmdOs.value === `windows`) {
        const args = props.hash === undefined ? `-Slug ${props.slug}` : `-Slug ${props.slug} -Hash ${props.hash}`;
        return psCommand(props.hash === undefined ? `updatePs1` : `rebuildPs1`, ``, args);
    }
    return bashCommand(key, ``, props.hash === undefined ? props.slug : `${props.slug} ${props.hash}`);
});
</script>

<template>
    <div class="flex flex-col gap-2">
        <template v-if="desktop">
            <Button :label="`${action} now`" class="self-start" @click="openDesktopLink(desktopRecreateLink(slug, hash))">
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">Runs here, on this computer. It takes a few minutes; your files (in /work) are kept.</p>
        </template>

        <template v-else>
            <ol class="ml-4 list-decimal text-2xs text-subtle">
                <li>Open a terminal on the computer that runs your sandbox.</li>
                <li>Copy and run the command below. It takes a few minutes; your files (in /work) are kept.</li>
            </ol>
            <Segmented
                v-model="cmdOs"
                size="sm"
                class="self-start"
                :options="[
                    { label: `Linux / macOS`, value: `unix` },
                    { label: `Windows`, value: `windows` },
                ]"
            />
            <Code :code="command" :lang="commandLang(cmdOs)" :label="`${action} command`" :wrap="true" />
            <!-- Offered here rather than only at setup: this is the card someone reaches for the third time,
                 which is the moment "there is an app that does this" is worth reading. -->
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
                <span>Skip the terminal next time —</span>
                <a :href="DESKTOP_DOWNLOADS.windows" class="text-link hover:underline">Intentic for Windows</a>
                <span>·</span>
                <a :href="DESKTOP_DOWNLOADS.linuxAppImage" class="text-link hover:underline">Linux</a>
                <span>does this with a button.</span>
            </p>
        </template>
    </div>
</template>
