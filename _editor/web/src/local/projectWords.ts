import { formatBytes } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { LocalProjectCaution, LocalProjectRefusal } from "../app/environments/localHost";
import type { HouseStage } from "./house/agentHouse";
import { formatCount } from "@intentic/ui/format";

// WHAT A FOLDER'S SANDBOX DIALOG AND THE HOUSE ON ITS CARD SAY, in the reader's language: the app answers with kinds
// and numbers (its project.rs), and the words are chosen here, where the catalogs are.

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
    const files = copy.more ? t(`local.project.moreFiles`, { count: formatCount(copy.files) }) : t(`local.project.files`, { count: formatCount(copy.files) }, copy.files);
    return copy.bytes > 0 ? t(`local.project.weight`, { files, size: formatBytes(copy.bytes) }) : files;
};

/** What the house is doing at `stage`, the card's headline while the build runs. */
export const stageHeadline = (stage: HouseStage): string => t(`local.project.stage.${stage}`);
