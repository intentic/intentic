<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useT } from "@intentic/ui/i18n";

// The one place the session's name is shown whole, in every form it's pasted as; raised from the agent page's chip, not
// the board, since this is where a name is looked up rather than glanced at.
// Three forms since three different tools want different ones (id for the worktree/CLI, branch for git, link to open
// the agent elsewhere); spelling all three out avoids a rule to remember.
// Values stay selectable text, not buttons themselves, so dragging a caret through a name still works and a copy button
// isn't nested inside a copy target.

const t = useT();

const { agentId, branch } = defineProps<{ agentId: string; branch: string }>();

const router = useRouter();
// Through the router, so the app's base path rides in the link, not left for the reader to add.
const link = computed(() => `${globalThis.location.origin}${router.resolve({ name: `agent`, params: { id: agentId } }).href}`);

const ROW = `flex items-start gap-2 rounded-lg px-2.5 py-1.5`;
</script>

<template>
    <!-- Rows already include their labels, so this column has no hover hints. -->
    <div class="flex flex-col p-1">
        <div :class="ROW">
            <span class="w-16 shrink-0 pt-px text-2xs text-subtle">{{ t(`agents.sessionIdentity.sessionId`) }}</span>
            <span class="min-w-0 flex-1 select-text break-all font-mono text-2xs text-content">{{ agentId }}</span>
            <CopyButton :text="agentId" :aria-label="t(`agents.sessionIdentity.copySessionId`)" />
        </div>
        <div :class="ROW">
            <span class="w-16 shrink-0 pt-px text-2xs text-subtle">{{ t(`agents.sessionIdentity.branch`) }}</span>
            <span class="min-w-0 flex-1 select-text break-all font-mono text-2xs text-content">{{ branch }}</span>
            <CopyButton :text="branch" :aria-label="t(`agents.sessionIdentity.copyBranchName`)" />
        </div>
        <div :class="ROW">
            <span class="w-16 shrink-0 pt-px text-2xs text-subtle">{{ t(`agents.sessionIdentity.link`) }}</span>
            <span class="min-w-0 flex-1 select-text break-all font-mono text-2xs text-content">{{ link }}</span>
            <CopyButton :text="link" :aria-label="t(`agents.sessionIdentity.copyLinkToAgent`)" />
        </div>
        <!-- The id is also what brings you back, via Quick Open. -->
        <p class="px-2.5 pb-1 pt-1.5 text-2xs text-subtle">{{ t(`agents.sessionIdentity.pasteIdIntoQuick`) }}</p>
    </div>
</template>
