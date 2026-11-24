import type { TranscriptPatch, TranscriptRow } from "../events/transcript.js";
import { newRowId } from "./row-ids.js";

// Each of a run's rows by its own id (TranscriptRow.rowId), kept beside the fold's rows (index for index) rather than in
// them: the fold mints nothing, and every change it makes to its rows leaves as a patch, so following the patches, in
// the fold's order, keeps the two aligned. A run carried on after a restart keeps the ids its rows were drawn under,
// which the windows showing it hold.
//
// In the contract, beside the row ids it hands out, because everything that serves a run stamps its rows the same way: the sandbox's
// daemon, and the desktop app's agents on a computer (2026-11-24). A reader finds where a run's rows sit in what it
// already holds by these stamps (`run`, `rowId`), so a server that left them off had its finished turn drawn twice.
export class RunRowIds {
    private readonly ids: string[];

    constructor(opening: readonly TranscriptRow[]) {
        this.ids = opening.map((row) => row.rowId ?? newRowId());
    }

    /** The id of the row at `index` as the fold holds it now. */
    at(index: number): string | undefined {
        return this.ids[index];
    }

    /**
     * A patch naming its row, and the stamp `run` on any row it carries: an append draws a new id (or keeps the one the
     * row came with), a drop lets its row's go, and every other change names the row it changes.
     */
    stamp(patch: TranscriptPatch, run: string): TranscriptPatch {
        switch (patch.op) {
            case "append": {
                const rowId = patch.row.rowId ?? newRowId();
                this.ids.push(rowId);
                return { ...patch, row: { ...patch.row, run, rowId } };
            }
            case "drop": {
                const [rowId] = this.ids.splice(patch.index, 1);
                return rowId === undefined ? patch : { ...patch, rowId };
            }
            case "replace": {
                const rowId = this.ids[patch.index];
                return rowId === undefined ? { ...patch, row: { ...patch.row, run } } : { ...patch, rowId, row: { ...patch.row, run, rowId } };
            }
            default: {
                const rowId = this.ids[patch.index];
                return rowId === undefined ? patch : { ...patch, rowId };
            }
        }
    }
}
