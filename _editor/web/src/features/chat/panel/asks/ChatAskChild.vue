<!-- A child this chat started, waiting on what only a person can answer: one line of the dock, who and what for, and the answers the board's card offers. -->
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
import ChatDockRow from "../dock/ChatDockRow.vue";
import { kindWord } from "./askWords";

const t = useT();

const props = defineProps<{ agentId: string; kind: WaitKind; canDrive: boolean; askKey: string }>();

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
    <!-- The way to the child's own chat: its title, a side door, when the answer is here; else the one way forward. -->
    <ChatDockRow
        v-if="agent"
        icon="subagents"
        tone="ask"
        :kind="kindWord(kind, t)"
        :title="agentDisplayTitle(agent)"
        :opens="answersHere ? t(`chat.askDock.openChat`) : undefined"
        :data-ask-line="askKey"
        @open="open"
    >
        <template v-if="!answersHere" #actions>
            <Button size="small" thumb tier="accent" @click="open"><Icon name="external-link" />{{ t(`chat.askDock.openChat`) }}</Button>
        </template>
        <CardPermissionAsk v-if="answersHere" :agent="agent" />
    </ChatDockRow>
</template>
