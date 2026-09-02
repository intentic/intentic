<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { useEnvironment } from "../../composables/sandbox/useEnvironment";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import EnginesCard from "./EnginesCard.vue";
import EnvironmentCard from "./EnvironmentCard.vue";
import MoveCard from "./MoveCard.vue";

/* The Sandbox hub's "Environment" tab, and it answers two questions in that order: WHAT THIS SANDBOX IS
 * (the composed overlay Dockerfile, agent-proposed and owner-approved; the engines that run its turns), and
 * then MOVING IT — out, or in.
 *
 * THE SECOND HALF USED TO BE THREE CARDS SPLIT BY ARTIFACT: "Move this sandbox" (the bundle), "Sandbox
 * definition" (the sandbox.toml) and "Arrive from another assistant". Two of those headings were not even on
 * the same axis — one named a job, the other named a file — so a reader who wanted to move a sandbox read the
 * first, exported gigabytes of private bytes, and never learned the publishable document existed. And each of
 * the three held BOTH directions at once, so every card asked its reader to keep in and out straight while
 * reading it.
 *
 * Splitting them by DIRECTION fixed the axis, and then two direction cards turned out to be one card: out and
 * in are halves of a single subject, not two subjects, so they share a surface and a heading in MoveCard. The
 * artifact is a choice inside each half rather than a card of its own.
 *
 * The overlay card sits above it because a bundle's last step IS the rebuild it hands you: the overlay travels
 * as a recipe and the image it describes does not. EnvironmentCard self-hides until there's an overlay or a
 * proposal, so this tab adds the empty-state for a sandbox that has neither yet. */

const { proposal, pending, applied, query } = useEnvironment();
const empty = computed(() => !proposal.value && !pending.value && !applied.value);

/* The empty state below is indistinguishable from the unread one: all three computeds read off a single
 * `state` that is undefined until /environment answers, so without this a sandbox WITH an overlay still opened
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

        <!-- Below the overlay and above the bundle, because it answers the same question one layer down: that
             card is what this sandbox has INSTALLED, this one is which version of the programs that run the
             turns. Never hidden — unlike the overlay above it, every sandbox has engines, and "which Claude
             Code am I on" is worth an answer before anything has gone wrong. -->
        <EnginesCard />

        <!-- One card, both directions. Out is drawn first inside it because it is the one an owner reaches for
             while still holding this sandbox; in is what they do on the far side, usually in a different
             browser on a different day. -->
        <MoveCard />
    </div>
</template>
