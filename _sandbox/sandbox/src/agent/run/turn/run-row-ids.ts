import type { TranscriptPatch, TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { newRowId } from "@intentic/sandbox-contract/ids/row-ids";
import { opt } from "../../../opt.js";

// Each of a run's rows by its own id (TranscriptRow.rowId), kept beside the fold's rows (index for index) rather than in
// them: the fold mints nothing, and every change it makes to its rows leaves as a patch, so following the patches, in
// the fold's order, keeps the two aligned. A run carried on after a restart keeps the ids its rows were drawn under,
// which the windows showing it hold.
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
                return { ...patch, ...opt("rowId", rowId), row: { ...patch.row, run, ...opt("rowId", rowId) } };
            }
            default: {
                const rowId = this.ids[patch.index];
                return rowId === undefined ? patch : { ...patch, rowId };
            }
        }
    }
}
