import { projectDirNameFor } from "@intentic/sandbox-contract";
import { formatBytes } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { LocalProjectCaution, LocalProjectRefusal } from "../app/environments/localHost";
import { autoSandboxName } from "../features/sandbox/client/sandboxName";
import type { HouseStage } from "./agentHouse";

// WHAT A FOLDER'S SANDBOX DIALOG AND BUILD CARD SAY, in the reader's language: the app answers with kinds and numbers
// (its project.rs), and the words are chosen here, where the catalogs are.

/** Why the folder at `path` cannot have a sandbox. */
export const refusalSentence = (refusal: LocalProjectRefusal, path: string): string => {
    switch (refusal.kind) {
        case `inside`:
            return t(`local.project.refusal.inside`, { other: refusal.other });
        case `around`:
            return t(`local.project.refusal.around`, { other: refusal.other });
        default:
            return t(`local.project.refusal.${refusal.kind}`, { path });
    }
};

/** What to beware of before the folder gets its sandbox. */
export const cautionSentence = (caution: LocalProjectCaution): string =>
    caution.kind === `synced` ? t(`local.project.caution.synced`, { service: caution.service }) : t(`local.project.caution.away`);

/** What the first copy carries: its files, and their size where it says anything. */
export const copyWeight = (copy: { readonly files: number; readonly bytes: number; readonly more: boolean }): string => {
    const files = copy.more ? t(`local.project.moreFiles`, { count: copy.files.toLocaleString() }) : t(`local.project.files`, { count: copy.files.toLocaleString() }, copy.files);
    return copy.bytes > 0 ? t(`local.project.weight`, { files, size: formatBytes(copy.bytes) }) : files;
};

/**
 * The names a folder's sandbox is made under, from the folder's own: the sandbox is called after it, numbered past a
 * name the account already gives another (features/sandbox/client/sandboxName.ts, as /setup names one), and the folder lands at `/work/<project>`.
 */
export const projectNames = (folder: string, taken: readonly string[]): { readonly name: string; readonly project: string } => ({
    name: autoSandboxName(taken, folder),
    project: projectDirNameFor(folder),
});

/** What the house is doing at `stage`, the card's headline while the build runs. */
export const stageHeadline = (stage: HouseStage): string => t(`local.project.stage.${stage}`);

/** Time left, at this machine's pace so far; nothing while there is nothing honest to say. */
export const remainingWords = (ms: number | undefined): string | undefined => {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
        return undefined;
    }
    if (ms < 60_000) {
        return t(`local.project.lessThanAMinute`);
    }
    const minutes = Math.round(ms / 60_000);
    return t(`local.project.minutesLeft`, { count: minutes }, minutes);
};
