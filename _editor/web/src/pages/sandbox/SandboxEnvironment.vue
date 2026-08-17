<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { useEnvironment } from "../../composables/sandbox/useEnvironment";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import BundleCard from "./BundleCard.vue";
import EnvironmentCard from "./EnvironmentCard.vue";
import MigrationCard from "./MigrationCard.vue";

/* The Sandbox hub's "Environment" tab: the composed overlay Dockerfile (agent-proposed, owner-approved, applied
 * by a rebuild), and below it the bundle card that moves the whole environment to another sandbox. The two
 * belong together — a restored bundle's last step IS the rebuild the card above hands you, because the overlay
 * travels as a recipe and the image it describes does not. EnvironmentCard self-hides until there's an overlay
 * or a proposal, so this tab adds the empty-state for a sandbox that has neither yet. */

const { proposal, pending, applied, query } = useEnvironment();
const empty = computed(() => !proposal.value && !pending.value && !applied.value);

/* The empty state below is indistinguishable from the unread one — all three computeds read off a single
 * `state` that is undefined until /environment answers — so without this a sandbox WITH an overlay still opened
 * on "no environment changes yet" and then replaced it with a diff. That is the one sentence on this tab a
 * reader might act on (propose a change that already exists), told wrong.
 *
 * The outline stands in for the card, not for the sentence: what is coming is a bordered block with a title and
 * a body of Dockerfile lines, and promising the empty state's shape would be promising the wrong answer. */
const reading = query.isLoading;
const outline = useSandboxOutline(reading);
</script>

<template>
    <div class="flex flex-col gap-4">
        <EnvironmentCard />

        <div v-if="outline" role="status" aria-busy="true" class="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
            <span class="sr-only">Reading this sandbox's environment…</span>
            <span class="skeleton block h-3.5 w-44" aria-hidden="true" />
            <div class="flex flex-col gap-2" aria-hidden="true">
                <span v-for="(width, index) in [`w-3/4`, `w-1/2`, `w-5/6`, `w-2/5`]" :key="index" class="skeleton block h-2.5" :class="width" />
            </div>
        </div>
        <!-- `!reading` and not merely `!outline`: the sentence must be silent for the whole wait, including the
             beat before the outline is allowed to appear. -->
        <div v-else-if="empty && !reading" :class="ui.emptyState('py-10')">
            No environment changes yet. When the agent proposes a change to the sandbox image's overlay, its diff appears here to review and rebuild.
        </div>

        <BundleCard />

        <!-- Beside the bundle card because they are the two crossings: a bundle moves an INTENTIC environment,
             this one translates a foreign assistant's home directory into native pieces. -->
        <MigrationCard />
    </div>
</template>
