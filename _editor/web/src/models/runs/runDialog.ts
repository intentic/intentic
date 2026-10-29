import { ref } from "vue";

// The window's one Run dialog (features/workspace/directory-ui/DirectoryRuns.vue, mounted by the shell): the repository it is open on, undefined when it
// is closed. Opened from the file tree's row and from a repository's app in Browsers, so where a run starts never
// depends on which of those is on screen.
export const runDialogRepo = ref<string | undefined>(undefined);
// Set by the first open and never cleared: the dialog's chunk loads on that ask and then stays, so its close fades out.
export const runDialogAsked = ref(false);

export const openRunDialog = (repo: string): void => {
    runDialogAsked.value = true;
    runDialogRepo.value = repo;
};
