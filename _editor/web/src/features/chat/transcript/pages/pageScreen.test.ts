import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import type { Page } from "@intentic/sandbox-contract/events/requests";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { AgentTranscript } from "../../../../models/conversations/transcript/agentTranscript";
import { inSetup, provided } from "../../../../testing/inSetup";
import { PAGE_RECORD_READER, type PageRecordReader, usePageScreen } from "./pageScreen";

// The full-screen page's state, against a record handed in as the daemon would answer it: the drawing that stands, found
// however far back it is, and a page that asks answered through the conversation's one reply, as on its card.

const CONVERSATION = `cnv_page`;
const page = (id: string, revision = 0): Page => {
    const drawn: Page = { id, title: `Pick a layout`, path: `.intentic/records/artifacts/pages/${CONVERSATION}/${id}.r${revision}.html` };
    if (revision > 0) {
        drawn.revision = revision;
    }
    return drawn;
};
const said = (text: string): TranscriptRow => ({ role: `assistant`, text });

/** A record of two pages, newest first: what the screen is handed for `opening`, then for the page above it. */
const recordOf = (newest: TranscriptRow[], above: TranscriptRow[] = []) => {
    const reads: string[] = [];
    const reader: PageRecordReader = {
        opening: async (id): Promise<AgentTranscript> => {
            reads.push(`opening ${id}`);
            return { messages: newest, from: above.length === 0 ? 0 : 20, more: above.length > 0 };
        },
        older: async (id, before): Promise<AgentTranscript> => {
            reads.push(`older ${id} ${before}`);
            return { messages: above, from: 0, more: false };
        },
    };
    return { reader, reads };
};

const screen = (reader: PageRecordReader, pageId: string) =>
    inSetup(
        () =>
            usePageScreen(
                () => CONVERSATION,
                () => pageId,
            ),
        { provides: [provided(PAGE_RECORD_READER, reader)] },
    ).result;

it(`draws the redraw that stands, read from as far back as the page was shown`, async () => {
    const { reader, reads } = recordOf(
        [said(`newest turn`)],
        [{ role: `assistant`, text: ``, page: page(`a1b2c3d4e5`) }, said(`redrawn`), { role: `assistant`, text: ``, page: page(`a1b2c3d4e5`, 1) }],
    );
    const shown = screen(reader, `a1b2c3d4e5`);

    await waitFor(() => expect(shown.reading.value).toBe(`found`));
    expect(shown.page.value?.path).toBe(`.intentic/records/artifacts/pages/${CONVERSATION}/a1b2c3d4e5.r1.html`);
    // A page that asks nothing takes no answer.
    expect(shown.submit.value).toBeUndefined();
    expect(reads).toEqual([`opening ${CONVERSATION}`, `older ${CONVERSATION} 20`]);
});

it(`answers a page that asks through the conversation's one reply, as its card in the chat does`, async () => {
    const { reader } = recordOf([{ role: `assistant`, text: ``, pageAsk: { requestId: `rq-7`, page: page(`0123456789`), status: `pending` } }]);
    const shown = screen(reader, `0123456789`);
    await waitFor(() => expect(shown.reading.value).toBe(`found`));
    const record = shown.record.value;
    const replies: unknown[][] = [];
    // The daemon taking the answer, and the row settling as CardReplies settles it.
    record.requests.reply = async (requestId, answer) => {
        replies.push([requestId, answer]);
        const row = record.transcript.messages.value.find((message) => message.pageAsk !== undefined)!;
        record.transcript.attachCard(row.id, { pageAsk: { ...row.pageAsk!, status: `answered`, value: `{"layout":"b"}` } });
        return true;
    };

    expect(await shown.submit.value?.(`{"layout":"b"}`)).toBeUndefined();
    expect(replies).toEqual([[`rq-7`, { kind: `page_ask`, value: `{"layout":"b"}` }]]);
    expect(shown.asked.value?.status).toBe(`answered`);
    // Answered once: the page is told so rather than sending a second answer.
    expect(await shown.submit.value?.(`{"layout":"c"}`)).toBe(`This page has already been answered.`);
    expect(replies).toHaveLength(1);
});

it(`says the page is missing from a record that never drew it, and the conversation gone when the daemon has none`, async () => {
    const missing = screen(recordOf([said(`nothing drawn`)]).reader, `a1b2c3d4e5`);
    await waitFor(() => expect(missing.reading.value).toBe(`missing`));
    expect(missing.page.value).toBeUndefined();

    const gone = screen({ opening: async () => `gone`, older: async () => `gone` }, `a1b2c3d4e5`);
    await waitFor(() => expect(gone.reading.value).toBe(`gone`));
});

it(`says a read failed, and reads again when asked`, async () => {
    let fails = true;
    const reader: PageRecordReader = {
        opening: async () => {
            if (fails) {
                throw new Error(`tunnel down`);
            }
            return { messages: [{ role: `assistant`, text: ``, page: page(`a1b2c3d4e5`) }], from: 0, more: false };
        },
        older: async () => `gone`,
    };
    const shown = screen(reader, `a1b2c3d4e5`);
    await waitFor(() => expect(shown.reading.value).toBe(`failed`));

    fails = false;
    await shown.read();
    expect(shown.reading.value).toBe(`found`);
    expect(shown.page.value?.id).toBe(`a1b2c3d4e5`);
});
