import { breakArmed } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useSandboxSettings } from "../../../sandbox/overview/useSandboxSettings";
import { usePaneView } from "../../panel/useChat-view";
import { effectivePolicy } from "../../run/turnBreak";

/**
 * Whether this pane's low-memory hold goes by itself once memory frees up: its conversation's answer to the memory
 * wall, else the sandbox's (turnBreak.ts). For the surfaces that say a hold without asking its question (the bar over
 * the composer), so they never call a message stuck that the sandbox is about to send.
 */
export const useMemoryAnswer = () => {
    const { conversation } = usePaneView();
    const { agentById } = useAgents();
    const { settings } = useSandboxSettings();
    const answer = computed(() => effectivePolicy(`memory`, agentById(conversation.value.conversationId), settings.value));
    return { answer, sendsItself: computed(() => breakArmed(answer.value)) };
};
