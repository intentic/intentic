import type { LocalFolderSetup, LocalSetupState } from "@intentic/web/local-host";
import { type FolderSetup, type FolderStanding, requirementOf } from "../desktop";

// A FOLDER ON ITS WAY TO ITS OWN SANDBOX, AS THE WINDOW'S CARD AND BUTTON DRAW IT (the web's local/LocalSetupCard.vue,
// local/LocalFiles.vue): the app's record (folder_setup.rs, device/folderSetups.ts), read into the few facts the shell
// takes. Pure, so what each state comes to is tested by value.

/** What a setup stopped on a question said this computer needs, in its own words (each requirement's title). */
export const needsOf = (requirements: readonly unknown[] | undefined): readonly string[] =>
    (requirements ?? []).map(requirementOf).flatMap((requirement) => (requirement === undefined || requirement.title === `` ? [] : [requirement.title]));

/** Where it stands, in the shell's shape: what the record leaves out is said as undefined. */
export const setupStateOf = (standing: FolderStanding & { readonly requirements?: readonly unknown[] | undefined }): LocalSetupState => {
    switch (standing.state) {
        case `queued`:
            return { state: `queued`, behind: standing.behind };
        case `creating`:
            return { state: `creating`, phase: standing.phase, step: standing.step, percent: standing.percent };
        case `needsDocker`:
            return { state: `needsDocker`, reason: standing.reason };
        case `waiting`:
            return { state: `waiting`, for: standing.for, needs: needsOf(standing.requirements) };
        case `failed`:
            return { state: `failed`, reason: standing.reason };
        default:
            return { state: standing.state };
    }
};

/** The record as the window's card draws it; nothing for a folder not on its way. */
export const folderSetupFor = (record: FolderSetup | undefined): LocalFolderSetup | undefined =>
    record === undefined
        ? undefined
        : {
              ...setupStateOf(record),
              name: record.name,
              status: record.status,
              heldBy: record.heldBy ?? [],
              made: record.made,
              hasLog: record.logPath !== undefined,
          };

/** The workspace's address for a folder's sandbox, opened on the folder (the app's project.rs `project_path`). */
export const projectPathOf = (args: { readonly sandboxId: string | undefined; readonly project: string | undefined }): string | undefined => {
    if (args.sandboxId === undefined || args.sandboxId === ``) {
        return undefined;
    }
    const query = new URLSearchParams({ sandbox: args.sandboxId });
    if (args.project !== undefined && args.project !== ``) {
        query.set(`project`, args.project);
    }
    return `/?${query.toString()}`;
};
