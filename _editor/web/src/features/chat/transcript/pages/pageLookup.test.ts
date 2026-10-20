import type { Page } from "@intentic/sandbox-contract/events/requests";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { AgentTranscript } from "../../../../models/conversations/transcript/agentTranscript";
import { findPage, PAGES_SEARCHED, standingDrawing } from "./pageLookup";

// A page is found by the id the daemon gave it, which a redraw keeps: the drawing that stands is the last one, and the
// record is read newest first until a page of it holds the id.

// The daemon files drawing N of a page as `<id>.rN.html` and says `revision` only from the first redraw on.
const drawing = (id: string, revision = 0): Page => {
    const page: Page = { id, title: `Chart`, path: `.intentic/records/artifacts/pages/cnv/${id}.r${revision}.html` };
    if (revision > 0) {
        page.revision = revision;
    }
    return page;
};
const shown = (page: Page): TranscriptRow => ({ role: `assistant`, text: ``, page });
const asked = (page: Page): TranscriptRow => ({ role: `assistant`, text: ``, pageAsk: { requestId: `rq-1`, page, status: `pending` } });
const said = (text: string): TranscriptRow => ({ role: `assistant`, text });

/** One page of the record, as the daemon's transcript route answers it. */
const recordPage = (messages: TranscriptRow[], from: number, more: boolean): AgentTranscript => ({ messages, from, more });

describe(`the drawing that stands`, () => {
    it(`is the last drawing of the id, since a redraw comes after what it replaced`, () => {
        const rows = [shown(drawing(`a1b2c3d4e5`)), said(`and again`), shown(drawing(`a1b2c3d4e5`, 1)), shown(drawing(`ffffffffff`))];
        expect(standingDrawing(rows, `a1b2c3d4e5`)?.page?.path).toBe(`.intentic/records/artifacts/pages/cnv/a1b2c3d4e5.r1.html`);
    });

    it(`is an asked page's card as well as a shown one`, () => {
        const row = asked(drawing(`0123456789`));
        expect(standingDrawing([said(`look`), row], `0123456789`)).toBe(row);
    });

    it(`is nothing for an id the rows never drew`, () => {
        expect(standingDrawing([shown(drawing(`a1b2c3d4e5`))], `0000000000`)).toBeUndefined();
    });
});

describe(`finding a page in the record`, () => {
    it(`takes the newest page of the record that holds it, reading older pages only as far as it must`, async () => {
        const older = jest.fn(async (before: number) =>
            before === 40 ? recordPage([shown(drawing(`a1b2c3d4e5`)), said(`there`)], 20, true) : recordPage([said(`older still`)], 0, false),
        );
        const found = await findPage(`a1b2c3d4e5`, recordPage([said(`newest`)], 40, true), older);
        expect(found).toEqual({ kind: `found`, rows: [shown(drawing(`a1b2c3d4e5`)), said(`there`)] });
        expect(older.mock.calls).toEqual([[40]]);
    });

    it(`is missing once the record runs out without it`, async () => {
        const older = jest.fn(async () => recordPage([said(`the start`)], 0, false));
        expect(await findPage(`a1b2c3d4e5`, recordPage([said(`newest`)], 20, true), older)).toEqual({ kind: `missing` });
        expect(older).toHaveBeenCalledTimes(1);
    });

    it(`stops after a bounded number of pages rather than reading a whole long record`, async () => {
        const older = jest.fn(async (before: number) => recordPage([said(`more`)], before - 1, true));
        expect(await findPage(`a1b2c3d4e5`, recordPage([said(`newest`)], 1000, true), older)).toEqual({ kind: `missing` });
        expect(older).toHaveBeenCalledTimes(PAGES_SEARCHED - 1);
    });

    it(`says so for a conversation the daemon does not have`, async () => {
        expect(await findPage(`a1b2c3d4e5`, `gone`, jest.fn())).toEqual({ kind: `gone` });
    });
});
