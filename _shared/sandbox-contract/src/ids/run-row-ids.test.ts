import type { TranscriptPatch, TranscriptRow } from "../events/transcript.js";
import { RunRowIds } from "./run-row-ids.js";

// The stamp every server of a run puts on its rows (the sandbox daemon, the desktop app's agents on a computer): which
// run made a row, and the row's own id, kept in step with the fold's rows by following its patches.

const row = (text: string, rowId?: string): TranscriptRow => (rowId === undefined ? { role: `assistant`, text } : { role: `assistant`, text, rowId });

describe(`RunRowIds`, () => {
    it(`keeps the ids its opening rows came with, and draws one for a row that has none`, () => {
        const ids = new RunRowIds([row(`kept`, `row_kept`), row(`new`)]);
        expect(ids.at(0)).toBe(`row_kept`);
        expect(ids.at(1)).toEqual(expect.any(String));
        expect(ids.at(1)).not.toBe(`row_kept`);
        expect(ids.at(2)).toBeUndefined();
    });

    it(`stamps an appended row with its run and a fresh id, and names the row every later change is about`, () => {
        const ids = new RunRowIds([]);
        const appended = ids.stamp({ op: `append`, row: row(`hello`) }, `run-1`);
        const rowId = ids.at(0);
        expect(appended).toEqual({ op: `append`, row: { role: `assistant`, text: `hello`, run: `run-1`, rowId } });
        expect(ids.stamp({ op: `text`, index: 0, text: ` there` }, `run-1`)).toEqual({ op: `text`, index: 0, rowId, text: ` there` });
        const replaced: TranscriptPatch = ids.stamp({ op: `replace`, index: 0, row: row(`whole`) }, `run-1`);
        expect(replaced).toEqual({ op: `replace`, index: 0, rowId, row: { role: `assistant`, text: `whole`, run: `run-1`, rowId } });
    });

    it(`lets a dropped row's id go, so the rows after it keep their own`, () => {
        const ids = new RunRowIds([row(`a`, `row_a`), row(`b`, `row_b`)]);
        expect(ids.stamp({ op: `drop`, index: 0 }, `run-1`)).toEqual({ op: `drop`, index: 0, rowId: `row_a` });
        expect(ids.at(0)).toBe(`row_b`);
    });

    it(`leaves a change to a row it never saw as it came`, () => {
        const ids = new RunRowIds([]);
        expect(ids.stamp({ op: `text`, index: 3, text: `late` }, `run-1`)).toEqual({ op: `text`, index: 3, text: `late` });
    });
});
