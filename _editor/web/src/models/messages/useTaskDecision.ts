import type { S2sContactTask } from "@intentic/sandbox-contract/schemas/s2s";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { ref, shallowRef } from "vue";
import { useMessagesApi } from "./messagesApi";
import { tasksChanged } from "./useMessages";

// ALLOW OR DECLINE a task a contact handed this sandbox that waits for the owner (docs/architecture/messages.md, "Waiting
// for the owner"): Allow starts it now, Decline ends it with nothing of it run. Both are the owner's or a maintainer's, as
// the daemon floors them. One answer at a time per list, the row being answered marked busy, and a refusal said in the
// daemon's own words under the list. The list is read again once the daemon has answered, so the task leaves the waiting
// rows and shows its new state on its contact.

/** A task's key among every contact's: its contact and the asking side's own id for it. */
export const taskKey = (task: Pick<S2sContactTask, `contact` | `requestId`>): string => `${task.contact}/${task.requestId}`;

export const useTaskDecision = () => {
    const api = useMessagesApi();
    /** The task being answered, by `taskKey`, while the daemon has not answered yet. */
    const deciding = ref<string>();
    const notice = shallowRef<ReturnType<typeof noticeFrom>>();

    /** Answers one waiting task; false when the daemon refused, which `notice` then says. */
    const decide = async (task: S2sContactTask, approve: boolean): Promise<boolean> => {
        if (deciding.value !== undefined) {
            return false;
        }
        deciding.value = taskKey(task);
        notice.value = undefined;
        try {
            await api.decideTask(task.contact, task.requestId, approve);
            await tasksChanged();
            return true;
        } catch (error) {
            notice.value = noticeFrom(error, approve ? t(`sandbox.messages.tasks.allowFailed`) : t(`sandbox.messages.tasks.declineFailed`));
            return false;
        } finally {
            deciding.value = undefined;
        }
    };

    return { deciding, notice, decide };
};
