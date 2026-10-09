import type { LocalFirstTask, LocalOnboardingHost } from "@intentic/web/local-host";
import { listen } from "@tauri-apps/api/event";
import { ref } from "vue";
import { firstTaskClear, firstTaskPickFolder, firstTaskQueue, firstTaskRead } from "../desktop";

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

export const firstTaskParts = (): FirstTaskParts => {
    const firstTask = ref<LocalFirstTask | undefined>(undefined);

    const refresh = async (): Promise<void> => {
        firstTask.value = parseTask(await firstTaskRead());
    };

    void refresh();
    void listen(`desktop://first-task`, (event) => {
        firstTask.value = parseTask(event.payload);
    });

    return {
        firstTask,
        pickFolder: async () => {
            const picked = await firstTaskPickFolder();
            return picked ?? undefined;
        },
        queueFirstTask: async (task) => {
            await firstTaskQueue(task.folder, task.text);
            await refresh();
        },
        clearFirstTask: async () => {
            await firstTaskClear();
            firstTask.value = undefined;
        },
    };
};
