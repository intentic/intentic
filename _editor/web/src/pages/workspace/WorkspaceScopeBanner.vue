<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAgents } from "../../composables/agents/useAgents";
import { usePersonas } from "../../composables/sandbox/usePersonas";
import { lensPersonaId, reachOf, reachSentence } from "../../composables/workspace/personaReach";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { workspaceAgent } from "../../composables/workspace/workspaceScope";

/* WHOSE WORKSPACE AM I LOOKING AT — on screen, for as long as the answer is not "the shared one".
 *
 * The scope is what makes a file address complete (workspaceScope), and it is invisible: the tree looks like a
 * tree and a file looks like a file. Without this strip the feature would trade one silent wrong answer for
 * another — a reader who followed a link out of a conversation, kept browsing, and had no way to know that the
 * `README.md` in front of them was one agent's unlanded draft rather than the repository's.
 *
 * So it names the agent, says the work has not landed, and offers the way out in one click. Nothing here is
 * dismissible: a banner the reader can turn off is a banner that is missing exactly when it matters.
 *
 * It also carries the ONE failure the scope has of its own. An archived agent keeps its work on its branch but
 * loses its checkout, so there is no tree to read — and a link in that conversation is still a link somebody
 * clicks months later. That is not a missing file and must not read as one: the daemon says so specifically
 * (PRECONDITION_FAILED, see workspace-scope.ts) and the sentence it sends is shown here, next to the route to
 * the work itself.
 */

const { agentById } = useAgents();
const { error } = useWorkspaceTree();

const agent = computed(() => (workspaceAgent.value === undefined ? undefined : agentById(workspaceAgent.value)));
// The agent's own name for itself is its first prompt; a conversation too new to have one is still worth
// naming as something rather than as a uuid.
const title = computed(() => agent.value?.title ?? `an agent`);
const toShared = (): void => {
    workspaceAgent.value = undefined;
};

/* THE SECOND THING THAT CAN MAKE THIS TREE NOT THE PLAIN ONE, and it belongs here rather than in a strip of its
 * own for the reason the first one does: a reader has to be told what they are looking at without asking, and
 * two banners stacked would each halve the other's chance of being read.
 *
 * They can be true at once — one agent's checkout, read as one persona — and then both lines show, because they
 * answer different questions: WHICH copy of the workspace, and WHOSE reach within it. */
const { personas } = usePersonas();
const lensCard = computed(() => personas.value.find((persona) => persona.id === lensPersonaId.value));
const lensLine = computed(() =>
    lensCard.value === undefined ? undefined : reachSentence(lensCard.value.label ?? lensCard.value.id, reachOf(lensCard.value)),
);
const clearLens = (): void => {
    lensPersonaId.value = undefined;
};
</script>

<template>
    <!-- WHOSE REACH. Its own stripe under the scope's, in a quieter tint: this changes what the tree MEANS, not
         which files it is showing, so it must not wear the same weight as a read-only checkout. -->
    <div v-if="lensLine !== undefined" class="flex shrink-0 items-start gap-2 border-b border-line bg-overlay px-3 py-1.5 text-2xs text-content">
        <Icon name="user" class="mt-0.5 shrink-0 text-[0.7rem] text-muted" />
        <!-- WRAPS RATHER THAN TRUNCATES, which is the opposite of the strip below it and deliberate: this one's
             payload is the FOLDER LIST, and a sidebar is 256px wide, so truncating cuts off exactly the part
             somebody turned the lens on to check. Two lines in a narrow sidebar is the right price for that. -->
        <span class="min-w-0 flex-1">{{ lensLine }}</span>
        <button
            type="button"
            class="shrink-0 rounded-md px-2 py-0.5 text-muted transition-colors hover:bg-overlay hover:text-content"
            @click="clearLens()"
        >
            Stop
        </button>
    </div>

    <div
        v-if="workspaceAgent !== undefined"
        class="flex shrink-0 items-center gap-2 border-b border-line bg-primary-600/10 px-3 py-1.5 text-2xs text-content"
    >
        <Icon name="robot" class="shrink-0 text-[0.7rem] text-link" />
        <template v-if="error === undefined">
            <span class="min-w-0 truncate">
                Showing <span class="font-medium">{{ title }}</span
                >'s copy of the workspace — its work hasn't landed yet, so these files are read-only.
            </span>
        </template>
        <template v-else>
            <span class="min-w-0 flex-1 truncate text-warning">{{ error }}</span>
            <RouterLink
                v-if="workspaceAgent !== undefined"
                :to="`/agents/${workspaceAgent}`"
                class="shrink-0 rounded-md px-2 py-0.5 text-link transition-colors hover:bg-overlay"
            >
                See its changes
            </RouterLink>
        </template>
        <span class="flex-1"></span>
        <button
            type="button"
            class="shrink-0 rounded-md px-2 py-0.5 text-muted transition-colors hover:bg-overlay hover:text-content"
            @click="toShared()"
        >
            Back to the shared workspace
        </button>
    </div>
</template>
