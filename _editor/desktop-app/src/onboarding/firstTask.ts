import type { LocalFirstTask, LocalOnboardingHost } from "@intentic/web/local-host";
import { projectDirCandidates } from "@intentic/sandbox-contract/ids/project-dir";
import { listen } from "@tauri-apps/api/event";
import { ref } from "vue";
import { firstTaskClear, firstTaskPickFolder, firstTaskQueue, firstTaskRead, firstTaskTakeDraft, type FirstTaskDraft } from "../desktop";

export type FirstTaskParts = Pick<LocalOnboardingHost, `firstTask` | `pickFolder` | `queueFirstTask` | `clearFirstTask`>;

const parseTask = (value: unknown): LocalFirstTask | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }
    const row = value as LocalFirstTask;
    if (typeof row.folder !== `string` || typeof row.text !== `string`) {
        return undefined;
    }
    return row;
};

/**
 * A first task begun by "Ask about this" while no sandbox could answer it (first_task.rs `prefill_from_ask`): This
 * computer's card fills its box with it and sets it back to undefined. Heard by every window open when it is made, and
 * taken from the app by a window opened after (the main window the app builds to show it), which leaves none for the next.
 */
export const draft = ref<FirstTaskDraft | undefined>(undefined);

const takeDraft = async (): Promise<void> => {
    try {
        draft.value = (await firstTaskTakeDraft()) ?? draft.value;
    } catch (error) {
        console.error(`[first task] the draft could not be taken:`, error);
    }
};

export const firstTaskParts = (): FirstTaskParts => {
    const firstTask = ref<LocalFirstTask | undefined>(undefined);

    const refresh = async (): Promise<void> => {
        firstTask.value = parseTask(await firstTaskRead());
    };

    void refresh();
    void listen(`desktop://first-task`, (event) => {
        firstTask.value = parseTask(event.payload);
    });
    void takeDraft();
    void listen<FirstTaskDraft>(`desktop://first-task-draft`, (event) => {
        draft.value = event.payload;
    });

    return {
        firstTask,
        pickFolder: async () => {
            const picked = await firstTaskPickFolder();
            return picked ?? undefined;
        },
        queueFirstTask: async (task) => {
            // What the folder may be called in this computer's sandbox: its own name, else its parent's in front of it.
            await firstTaskQueue(task.folder, task.text, projectDirCandidates(task.folder));
            await refresh();
        },
        clearFirstTask: async () => {
            await firstTaskClear();
            firstTask.value = undefined;
        },
    };
};
