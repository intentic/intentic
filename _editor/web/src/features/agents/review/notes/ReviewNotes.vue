<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { stopAgent } from "../../../../models/fleet/agentActions";
// Where the user's own conflict half is resolved: the Changes panel, the same deep-link the card and the badges use.
import { openChanges } from "../../../../models/changes/openChanges";
import AgentConflictReport from "./AgentConflictReport.vue";
import AgentIgnoredReport from "./AgentIgnoredReport.vue";
import AgentScratchReport from "./AgentScratchReport.vue";
import ReviewDependencyNotes from "./ReviewDependencyNotes.vue";
import ReviewUncarriedNotes from "./ReviewUncarriedNotes.vue";
import type { useAgentChanges } from "../useAgentChanges";
import { useOwnerHold } from "../../../../models/conversations/review/settingsRefusal";
import type { OwnerHold } from "../../../../models/conversations/review/ownerHold";

// Everything the review says above its two columns (AgentReviewPanel): a failed read, a refused land and what it left,
// work no land carries, scratch, ignored outputs, and the dependencies landing takes on. All of it sits in one box that
// stops short of the screen and scrolls past that, so however much there is to say (a long scratch list, a dependency
// in every package of a monorepo) the file list and its diff keep the rest.

const t = useT();

const { agentId, at, changes } = defineProps<{
    agentId: string;
    changes: ReturnType<typeof useAgentChanges>;
    // Whether this browser is streaming the agent's turn; what "have the agent resolve it" waits on.
    streaming: boolean;
    // Agent is mid-write, so a land would catch it half-done; what the merge offer waits on.
    writing: boolean;
    // Sandbox this agent's worktree is on, absent for the active one.
    at?: string;
    // That sandbox's name, read by the panel once for both of them.
    remoteName?: string;
}>();
// The conflict report's moves that belong to the panel: watch the turn (phone), cross to the agent's sandbox, and
// narrow the list to the conflicts.
const emit = defineEmits<{ chat: []; cross: []; show: [] }>();

// A notice that needs no decision: one line under the bar, no box, so only the bar reads as something to act on.
const NOTE_LINE = `mx-2 mt-1.5 flex shrink-0 items-center gap-1.5 px-2 text-2xs text-muted`;

// What a refused land left behind; causes and the action ladder are AgentConflictReport's to own.
const resolvingPaths = computed(() => (changes.resolving.value ?? []).flatMap((entry) => entry.paths));
// What the owner's half of the refusal is, read off their own Changes, as the board card reads it.
const refused = (): boolean => (changes.conflicts.value?.length ?? 0) > 0;
const owner = useOwnerHold(() => ({ sandboxId: at }), refused, () => changes.conflicts.value);
const mainBranch = computed(() => changes.conflicts.value?.find((conflict) => conflict.mainBranch !== undefined)?.mainBranch);
</script>

<template>
    <div class="max-h-[40vh] shrink-0 overflow-y-auto">
        <Notice v-if="changes.error.value" tone="danger" size="sm" class="mx-2 mt-2 shrink-0">
            <span class="block font-medium">{{ t(`agents.agentReviewPanel.couldntReadAgentsChanges`) }}</span>
            <span class="block break-words text-muted">{{ changes.error.value }}</span>
        </Notice>

        <!-- The one decision a refused land leaves, first: what conflicts, why, and what happens next. -->
        <AgentConflictReport
            v-if="changes.conflicts.value !== undefined && changes.conflicts.value.length > 0"
            class="mx-2 mt-2"
            :conflicts="changes.conflicts.value"
            :streaming="streaming"
            :writing="writing"
            :busy="changes.actionBusy.value"
            :asked="changes.asked.value"
            :queued="changes.fixQueued.value"
            :box="remoteName"
            :owner="owner"
            @keep-deleted="(held: OwnerHold) => changes.keepDeletedFiles(held, mainBranch)"
            @restore-deleted="(held: OwnerHold) => changes.restoreDeletedFiles(held)"
            @merge="changes.land('merge')"
            @settle="changes.settle()"
            @commit="openChanges"
            @save-settings="(paths: readonly string[]) => changes.land(`check`, undefined, false, paths)"
            @stop="stopAgent(agentId, at)"
            @cancel="changes.cancelFix()"
            @cross="emit('cross')"
            @chat="emit('chat')"
            @show="emit('show')"
        />

        <!-- What a merge land left behind: everything else applied, these files carry markers to finish in the workspace. -->
        <div v-if="resolvingPaths.length > 0" :class="NOTE_LINE">
            <Icon name="info-circle" class="shrink-0 text-2xs text-info" />
            <span class="min-w-0 flex-1 truncate" v-tooltip.bottom.overflow="resolvingPaths.join(`, `)">{{
                t(`agents.agentReviewPanel.markersLeft`, { count: resolvingPaths.length }, resolvingPaths.length)
            }}</span>
            <button type="button" class="shrink-0 text-link underline-offset-2 hover:underline" @click="openChanges">
                {{ t(`agents.agentConflictReport.openChanges`) }}
            </button>
        </div>

        <!-- Work no land carries: stranded on another branch, or written where no repository stood. -->
        <ReviewUncarriedNotes :agent-id="agentId" :at="at" :changes="changes" />

        <!-- What no land carries: files that look like scratch, left in the conversation's copy until included or deleted. -->
        <AgentScratchReport
            v-if="changes.scratch.value.length > 0"
            class="mx-2 mt-2"
            :scratch="changes.scratch.value"
            :busy="changes.actionBusy.value"
            :streaming="streaming"
            @include="changes.includeScratch"
            @delete="changes.deleteScratch"
        />

        <!-- What no land carries because the repository ignores it (a render in out/): copied into the owner's tree on a
             press, beside git rather than through it. -->
        <AgentIgnoredReport
            v-if="changes.ignored.value.length > 0"
            class="mx-2 mt-2"
            :ignored="changes.ignored.value"
            :busy="changes.actionBusy.value"
            :streaming="streaming"
            @copy="changes.copyIgnored"
        />

        <!-- What landing this work takes on: a quiet line per manifest, folded into one past a few. -->
        <ReviewDependencyNotes :repos="changes.repos.value" />
    </div>
</template>
