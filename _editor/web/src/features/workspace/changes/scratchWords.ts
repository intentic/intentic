import type { ScratchPath, ScratchReason } from "@intentic/sandbox-contract/schemas/git/git";
import { formatBytes, formatCount } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { folderTotals } from "../../../models/workspace/changes/scratchFolders";

// What both Changes panels say about a scratch folder: why it is left out, how big it is, and the question asking to
// delete it. The daemon's own words for the reasons are a sentence for the contract (ScratchReasonSchema); these are
// the short labels a row can hold.

// Each wording spelled as its own call, so the catalog check can see every message asked for.
const REASONS = {
    hidden: () => t(`workspace.scratchFolder.hidden`),
    byproduct: () => t(`workspace.scratchFolder.byproduct`),
    checkout: () => t(`workspace.scratchFolder.checkout`),
    oversized: () => t(`workspace.scratchFolder.oversized`),
    root: () => t(`workspace.scratchFolder.root`),
    bulk: () => t(`workspace.scratchFolder.bulk`),
} satisfies Readonly<Record<ScratchReason, () => string>>;

const reasonWords = (reason: ScratchReason): string => REASONS[reason]();

/** "4,992 files · 1.2 GB"; undefined for a checkout of its own, which the daemon does not walk. */
const sizeWords = (totals: Pick<ScratchPath, "files" | "bytes">): string | undefined =>
    totals.files === undefined
        ? undefined
        : t(`workspace.scratchFolder.size`, { files: formatCount(totals.files), size: formatBytes(totals.bytes) }, totals.files);

/** "4,992 files · 1.2 GB · Too large to save with your changes": what it is, then why it is left out. */
export const folderLine = (entry: ScratchPath): string => [sizeWords(entry), reasonWords(entry.reason)].filter((part) => part !== undefined).join(` · `);

/** The question the confirm card asks before one folder goes: the count and size, never the names. */
export const deleteQuestion = (entry: ScratchPath, label: string): string =>
    entry.files === undefined
        ? t(`workspace.scratchFolder.deleteWhole`, { path: label })
        : t(`workspace.scratchFolder.deleteQuestion`, { files: formatCount(entry.files), size: formatBytes(entry.bytes), path: label }, entry.files);

/** The line a whole-repository discard adds when folders left out of saves go with it; undefined when there are none. */
export const alsoDeletesLine = (folders: readonly ScratchPath[]): string | undefined => {
    if (folders.length === 0) {
        return undefined;
    }
    const totals = folderTotals(folders);
    return t(
        `workspace.scratchFolder.alsoDeletes`,
        { count: folders.length, size: sizeWords({ files: totals.files, bytes: totals.bytes }) ?? `` },
        folders.length,
    );
};
