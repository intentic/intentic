import type { LandedMessage, RepoChanges } from "@intentic/api-contract";
import { ALL_SIDES, commitMessageOf, originsOf } from "../changeOrigins";
import { truncatedTotal } from "../truncation";

// What a maker's one Save press records the tree under. A maker never writes a commit message, so the subject is
// chosen for them: the sentence the commit-message model already wrote for an assistant's landing when the whole
// tree is that one landing, and a constant otherwise. Nothing here asks a model — the drafting happened at land
// time (conversations/land/landed-subject.ts) and this only spends what it produced.

// The subject the daemon writes for the tree's own dirty remainder (version-landed.ts). Reused verbatim so a save
// pressed by hand and one made for the owner read the same in the history.
export const OWN_EDITS_SUBJECT = `Your edits`;

// The one assistant every uncommitted file in the tree was landed by, or undefined when it holds anyone else's
// work. A path with no origin is the owner's own hand edit, which disqualifies a landing's sentence from
// describing the whole save; so does a repo whose list the daemon truncated, since the rows it dropped could
// carry any origin at all.
export const soleOrigin = (repos: readonly RepoChanges[]): string | undefined => {
    const ids = new Set<string>();
    for (const repo of repos) {
        if (truncatedTotal(repo) > 0) {
            return undefined;
        }
        for (const path of new Set(ALL_SIDES.flatMap((side) => repo[side]).map((change) => change.path))) {
            const landed = originsOf(repo, path);
            if (landed.length === 0) {
                return undefined;
            }
            for (const id of landed) {
                ids.add(id);
            }
            if (ids.size > 1) {
                return undefined;
            }
        }
    }
    return ids.size === 1 ? [...ids][0] : undefined;
};

/** The message a save would record, and the assistant it came from when one wrote it. */
export interface SavedMessage {
    readonly message: string;
    // Set only when the message is that landing's own sentence; the panel names it so the save isn't anonymous.
    readonly from?: string;
}

// `messageOf` is the caller's lookup into whatever carries a landing's sentence (the agent's card, or the review's
// origin record); undefined from it means the draft is still running, refused, or was never asked for.
export const savedMessage = (repos: readonly RepoChanges[], messageOf: (id: string) => LandedMessage | undefined): SavedMessage => {
    const only = soleOrigin(repos);
    const written = only === undefined ? undefined : commitMessageOf(messageOf(only));
    return written === undefined ? { message: OWN_EDITS_SUBJECT } : { message: written, from: only };
};
