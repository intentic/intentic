import { z } from "zod";
import { opt } from "../../opt.js";
import type { PersistedAgent } from "./agents-store.js";

// THE LAND BOOKKEEPING A RESTART MUST NOT LOSE (2026-10-19). Two things a land leaves to happen later, each of which
// lived only in memory until then, so a daemon that died in between forgot it: the version commit a land into the main
// tree still owes (land/version-landed.ts), and the land a turn's close skipped because a wake was armed
// (land/wake-held.ts). Both are kept on the conversation's record, written the moment they begin and cleared the moment
// they are answered, so the boot finds exactly what was still owed. Added 2026-10-19, optional: a row written before it
// owes nothing.

export const LandMarksSchema = z.object({
    // When a land reached the main tree whose version commit (and drafted subject) has not been written yet; cleared by
    // the settle that ran for that land, and run again at boot when a restart cut it (version-landed.ts).
    versionPending: z.number().optional(),
    // The land the last close skipped because the conversation would run again by itself, with that turn's own answer
    // to landing by itself (TurnInput.autoLand; absent left it to the posture and the rules) (wake-held.ts).
    wakeHeld: z.object({ autoLand: z.boolean().optional() }).optional(),
});
export type LandMarks = z.infer<typeof LandMarksSchema>;

const NONE: LandMarks = {};

// The marks a record carries, none when it carries no field.
export const landMarksOf = (entry: Pick<PersistedAgent, "landMarks"> | undefined): LandMarks => entry?.landMarks ?? NONE;

// Whether a land that just reached a tree owes a version commit: one that changed the main tree itself, not a parent's
// checkout (land-target.ts), whose own land is what reaches the main tree.
export const owesVersionCommit = (outcome: { readonly landed: boolean; readonly changed: boolean; readonly into?: string | undefined }): boolean =>
    outcome.landed && outcome.changed && outcome.into === undefined;

// The marks with every absent one left out, none at all when nothing is owed: what a record keeps.
const kept = ({ versionPending, wakeHeld }: LandMarks): LandMarks | undefined =>
    versionPending === undefined && wakeHeld === undefined ? undefined : { ...opt("versionPending", versionPending), ...opt("wakeHeld", wakeHeld) };

// The record with these marks, the field dropped when none is left, so a record that owes nothing reads as before.
const withLandMarks = (entry: PersistedAgent, marks: LandMarks): PersistedAgent => {
    const { landMarks: _replaced, ...rest } = entry;
    const next = kept(marks);
    return next === undefined ? rest : { ...rest, landMarks: next };
};

const sameMarks = (a: LandMarks, b: LandMarks): boolean => JSON.stringify(kept(a) ?? NONE) === JSON.stringify(kept(b) ?? NONE);

// The registry's books a land mark is written through.
export interface LandMarkBooks {
    readonly entryOf: (id: string) => PersistedAgent | undefined;
    readonly replace: (next: PersistedAgent) => void;
    readonly persist: () => Promise<void>;
}

// The record as a land leaves it: one that reached the main tree owes its version commit from that write on, so a
// restart before the commit still makes it (version-landed.ts settlePendingVersions).
export const markedOnLand = (entry: PersistedAgent, outcome: Parameters<typeof owesVersionCommit>[0]): PersistedAgent =>
    owesVersionCommit(outcome) ? withLandMarks(entry, { ...landMarksOf(entry), versionPending: Date.now() }) : entry;

// AgentsRegistry.amendLandMarks over the registry's own books: written at once, never broadcast (nothing on a card reads
// them), and no write at all when the change leaves them as they were.
export const landMarksAmender =
    (books: LandMarkBooks) =>
    async (id: string, change: (marks: LandMarks) => LandMarks): Promise<void> => {
        const entry = books.entryOf(id);
        if (entry === undefined) {
            return;
        }
        const before = landMarksOf(entry);
        const after = change(before);
        if (sameMarks(before, after)) {
            return;
        }
        books.replace(withLandMarks(entry, after));
        await books.persist();
    };
