import { t } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { openDesktopLink } from "../../../app/environments/desktop";
import { useNotifications } from "../../../workbench/notifications/notifications";
import { startAgent } from "../../agents/fleet/agentActions";
import { drawsChat } from "../run/chatEcho";
import { conversations } from "../tabs/useChat-tabs";
import { rememberTaskSent, takeTaskHandoff } from "./localTaskHandoff";

const inShell = (path: string): boolean => path === `/` || path.startsWith(`/workspace`);

const SENT_DEADLINE_MS = 30_000;

const reportSent = (id: string): void => {
    rememberTaskSent(id);
    openDesktopLink(`intentic://first-task?do=sent&id=${encodeURIComponent(id)}`);
};

const reportFailed = (id: string, reason: string): void => {
    openDesktopLink(`intentic://first-task?do=failed&id=${encodeURIComponent(id)}&reason=${encodeURIComponent(reason)}`);
};

/** Wait until the conversation shows a turn in flight, errors, or the deadline passes. */
const waitForTurnStarted = (conversationId: string): Promise<boolean> =>
    new Promise((resolve) => {
        const conversation = conversations.value.find((entry) => entry.conversationId === conversationId);
        if (conversation === undefined) {
            resolve(false);
            return;
        }
        const deadline = window.setTimeout(() => {
            stop();
            resolve(false);
        }, SENT_DEADLINE_MS);
        const stop = watch(
            () =>
                conversation.turn.streaming.value ||
                conversation.status.value === `error` ||
                conversation.transcript.messages.value.some((message) => message.role === `user`),
            (started) => {
                if (!started) {
                    return;
                }
                window.clearTimeout(deadline);
                stop();
                resolve(conversation.status.value !== `error`);
            },
            { immediate: true },
        );
    });

const runTask = async (handoff: { readonly id: string; readonly text: string }): Promise<void> => {
    const { warn } = useNotifications();
    const conversationId = startAgent(handoff.text);
    const started = await waitForTurnStarted(conversationId);
    if (started) {
        reportSent(handoff.id);
        return;
    }
    const reason = t(`local.agents.taskSendFailed`);
    warn(reason);
    reportFailed(handoff.id, reason);
};

let ready: (() => boolean) | undefined;

const tryRun = (): void => {
    if (ready?.() !== true) {
        return;
    }
    const handoff = takeTaskHandoff();
    if (handoff !== undefined) {
        void runTask(handoff);
    }
};

/** Sends the kept first task once this window can show a chat. Idempotent. `currentPath` is the router's to answer. */
export const startLocalTask = (currentPath: () => string): void => {
    if (ready === undefined) {
        const { user } = useAuth();
        const { activeSandboxId, reachable } = useSandbox();
        const canShow = computed(
            () =>
                user.value !== null &&
                activeSandboxId.value !== undefined &&
                reachable.value &&
                drawsChat.value &&
                inShell(currentPath()),
        );
        ready = () => canShow.value;
        watch(canShow, tryRun);
    }
    tryRun();
};
