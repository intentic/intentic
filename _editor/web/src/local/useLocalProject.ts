import { computed, ref } from "vue";
import { askLocalApp } from "../app/environments/local";
import { localHost, type LocalProjectBuild, type LocalProjectPreview } from "../app/environments/localHost";
import { projectNames } from "./projectWords";

// "WORK ON THIS WITH AN AGENT", as this window asks it: its own dialog first (LocalProjectDialog.vue), and then, on
// "Create sandbox", the sandbox made and built on this computer while the reader keeps working, its card over the folder
// (LocalProjectBuild.vue). One per window: a window shows one folder, and the app builds one sandbox at a time. Where the
// app cannot make one from here (a page with no app behind it), the press goes to the app by link, as it always did.

// allow(module-state): one folder per window, so one question and one build.
const dialogOpen = ref(false);
// What the dialog draws; undefined while the app is still weighing the folder.
const preview = ref<LocalProjectPreview | undefined>(undefined);
const creating = ref(false);
// Why the last press made nothing, in the app's own words.
const failure = ref<string | undefined>(undefined);
// The build's card folded to one line by the reader, who can unfold it from there or from the folder's button.
const minimized = ref(false);

const host = () => localHost().project;

const build = computed<LocalProjectBuild | undefined>(() => host()?.build.value);

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The dialog, for this window's folder; a folder that has its sandbox already is opened instead. */
const ask = async (): Promise<void> => {
    const project = host();
    if (project === undefined) {
        askLocalApp(`sandbox`);
        return;
    }
    // A build on its card is the answer already, under way or stopped: the card is brought back rather than a second
    // question asked, so a stopped one is tried again on the same sandbox (its "Try again") or put away first.
    if (build.value !== undefined) {
        minimized.value = false;
        return;
    }
    failure.value = undefined;
    preview.value = undefined;
    dialogOpen.value = true;
    try {
        const answer = await project.preview();
        if (answer.kind === `existing`) {
            dialogOpen.value = false;
            askLocalApp(`sandbox`);
            return;
        }
        preview.value = answer;
    } catch (error) {
        failure.value = words(error);
    }
};

/** "Create sandbox": the names derived from the folder's own, the sandbox made, and its build begun in this window. */
const create = async (): Promise<void> => {
    const project = host();
    const asked = preview.value;
    if (project === undefined || asked?.kind !== `new` || creating.value) {
        return;
    }
    creating.value = true;
    failure.value = undefined;
    try {
        const taken = (await localHost().roster()).sandboxes.map((sandbox) => sandbox.name);
        await project.create(projectNames(asked.name, taken));
        minimized.value = false;
        dialogOpen.value = false;
    } catch (error) {
        failure.value = words(error);
    } finally {
        creating.value = false;
    }
};

const cancel = (): void => {
    if (!creating.value) {
        dialogOpen.value = false;
    }
};

/** The build's card, folded or unfolded. */
const fold = (folded: boolean): void => {
    minimized.value = folded;
};

// Why the last "Try again" started nothing (the platform out of reach, a setup already running): said on the card, in
// place of the failure it was meant to get past.
const retryFailure = ref<string | undefined>(undefined);

/** The stopped build again, on the same sandbox. */
const retry = async (): Promise<void> => {
    retryFailure.value = undefined;
    try {
        await host()?.retry();
    } catch (error) {
        retryFailure.value = words(error);
    }
};

export const useLocalProject = () => ({ dialogOpen, preview, creating, failure, minimized, build, ask, create, cancel, fold, retry, retryFailure });
