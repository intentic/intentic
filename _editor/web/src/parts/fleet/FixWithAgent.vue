<script setup lang="ts">
import { AgentRunButton, type ButtonTier, type TooltipValue, useAgentRunPick } from "@intentic/ui";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import { type AgentFix, FIX_ROLE } from "../../models/fixes/agentFix";
import { startFix } from "../../models/fleet/agentActions";
import { shellModelPicking } from "../../models/conversations/accounts/shellModelPicking";

// THE PRESS EVERY FAILURE THE APP CANNOT SETTLE BY ITSELF OFFERS (agentFix.ts): a failed sync, a refused push or commit,
// a crashed dev server, a failed build. One split button on the `workflow-fix` job, its caret re-pointing the model for
// this run alone, as every run button's does (AgentRunButton). The surface says what failed; this decides nothing else.

const t = useT();

const {
    fix,
    tier = `boring`,
    label = undefined,
} = defineProps<{
    fix: AgentFix;
    tier?: ButtonTier;
    // The surface's own verb, where "Fix with agent" says less than it could ("Resolve with agent").
    label?: string | undefined;
}>();
// The conversation it opened, for a surface that retires its own card once somebody is on it.
const emit = defineEmits<{ started: [conversationId: string] }>();

const picker = useAgentRunPick(shellModelPicking, FIX_ROLE);
const shown = computed(() => label ?? t(`agents.fixWithAgent.label`));

// Whose tree the run touches is the one thing a reader should know before pressing: their own checkout, planned first,
// or a copy that lands as a reviewable diff.
const hint = computed(
    (): TooltipValue => ({
        title: t(`agents.fixWithAgent.title`),
        note: fix.tree === `shared` ? t(`agents.fixWithAgent.sharedNote`) : t(`agents.fixWithAgent.ownNote`),
    }),
);

const run = (): void => {
    const conversationId = startFix(fix, picker.model.value);
    picker.clear();
    emit(`started`, conversationId);
};
</script>

<template>
    <AgentRunButton :label="shown" :picker="picker" :tier="tier" icon="sparkles" size="small" :hint="hint" data-fix-with-agent @run="run" />
</template>
