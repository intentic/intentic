<!-- A child this chat started, waiting on what only a person can answer: who, what for, and the answers the board's card offers. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { answerableAsk } from "../../../../models/fleet/presses/boardAnswer";
import CardPermissionAsk from "../../../../parts/fleet/CardPermissionAsk.vue";
import type { WaitKind } from "../../../../models/conversations/panel/pendingAsks";
import { agentDisplayTitle } from "../../../../models/agent-status/agentStatus-meta";
import { agentTabOf } from "../../../../models/conversations/panel/useChat-reveal";
import { summonChat } from "../../../../models/conversations/run/summon";
import { agentSeed } from "../../../../models/fleet/useAgents-actions";
import { useAgents } from "../../../../models/fleet/useAgents";
import { kindWord } from "./askWords";

const t = useT();

const props = defineProps<{ agentId: string; kind: WaitKind; canDrive: boolean }>();

const { agentById } = useAgents();
const agent = computed(() => agentById(props.agentId));
// A permission answered right here, as on the board: Allow once or Skip. Anything else is answered in the child's own chat.
const answersHere = computed(() => props.canDrive && agent.value !== undefined && answerableAsk(agent.value) !== undefined);
const open = (): void => {
    const child = agent.value;
    if (child !== undefined) {
        summonChat({ kind: `reveal`, verb: `focus`, entries: [agentTabOf(agentSeed(child))], focus: child.id, caret: false });
    }
};
</script>

<template>
    <div v-if="agent" class="chat-card flex w-full flex-col">
        <div class="chat-card-header items-center text-xs">
            <Icon name="subagents" class="text-sm text-accent" />
            <span class="min-w-0 truncate font-semibold text-content" v-tooltip.top.overflow="agentDisplayTitle(agent)">
                {{ agentDisplayTitle(agent) }}<span class="font-normal text-muted"> · {{ kindWord(kind, t) }}</span>
            </span>
            <!-- The way to the child's own chat: the one way forward when nothing is answered here, a side door when it is. -->
            <Button size="small" :tier="answersHere ? `quiet` : `accent`" class="shrink-0" @click="open">
                <Icon name="external-link" />{{ t(`chat.askDock.openChat`) }}
            </Button>
        </div>
        <div v-if="answersHere" class="chat-card-row">
            <CardPermissionAsk :agent="agent" />
        </div>
    </div>
</template>
