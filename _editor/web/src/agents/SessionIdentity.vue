<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";

/* THE ONE PLACE THE SESSION'S NAME IS SHOWN WHOLE, and in every form anyone pastes it in. Raised from the
 * agent page's chip (a popover on desktop, a sheet on a phone), because that page is where a name is looked UP
 * — the board is where it is glanced at, and glancing wants one gesture, not a menu.
 *
 * Three forms, because the same name is asked for by three different things and only one of them is on screen
 * anywhere today:
 *   - the ID is what the worktree is called and what the CLI takes,
 *   - the BRANCH is what git takes,
 *   - the LINK is how the agent is opened in another window, or on the phone in your hand.
 * Spelling all three out beats a single value plus a rule the reader has to remember ("drop the agent/ off the
 * front"), and it is what makes the copy honest: what you press is beside the exact text it hands over.
 *
 * The values stay selectable text rather than becoming buttons themselves — a row you can drag a caret through
 * is the escape hatch for the half of a name someone actually wants, and nesting a copy button inside a copy
 * target would make the row answer one press two ways. */

const { agentId, branch } = defineProps<{ agentId: string; branch: string }>();

const router = useRouter();
// Through the router, so the app's own base path is part of the link rather than something the reader has to
// add back. Same origin the user is already on — which is the sandbox this agent lives in.
const link = computed(() => `${globalThis.location.origin}${router.resolve({ name: `agent`, params: { id: agentId } }).href}`);

const ROW = `flex items-start gap-2 rounded-lg px-2.5 py-1.5`;
</script>

<template>
    <div class="flex flex-col p-1">
        <div :class="ROW">
            <span class="w-16 shrink-0 pt-px text-2xs text-subtle">Session id</span>
            <span class="min-w-0 flex-1 select-text break-all font-mono text-2xs text-content">{{ agentId }}</span>
            <CopyButton :text="agentId" v-tooltip.left="'Copy the session id'" />
        </div>
        <div :class="ROW">
            <span class="w-16 shrink-0 pt-px text-2xs text-subtle">Branch</span>
            <span class="min-w-0 flex-1 select-text break-all font-mono text-2xs text-content">{{ branch }}</span>
            <CopyButton :text="branch" v-tooltip.left="'Copy the branch name'" />
        </div>
        <div :class="ROW">
            <span class="w-16 shrink-0 pt-px text-2xs text-subtle">Link</span>
            <span class="min-w-0 flex-1 select-text break-all font-mono text-2xs text-content">{{ link }}</span>
            <CopyButton :text="link" v-tooltip.left="'Copy a link to this agent'" />
        </div>
        <!-- The reason the id is worth carrying anywhere: it is also what brings you back. Said once, here,
             rather than as a hint on every surface that prints the name. -->
        <p class="px-2.5 pb-1 pt-1.5 text-2xs text-subtle">Paste the id into Quick Open to come back to this agent from anywhere.</p>
    </div>
</template>
