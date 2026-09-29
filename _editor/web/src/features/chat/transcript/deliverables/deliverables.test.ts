// Which documents a turn lists under its answer, and in what order: what its edits wrote and what the daemon found its
// commands wrote, a delegation's included, a file written twice kept once where it was last written, a failed edit, a
// read and a deleted file left out, and source never counted.
import type { TranscriptTool } from "@intentic/sandbox-contract";
import type { ChatMessage, ChatTurn } from "../transcript";
import { deliverableName, deliverablesByTurn, deliverablesOfTurn } from "./deliverables";

let nextId = 0;
const row = (over: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage => ({ id: (nextId += 1), text: ``, ...over });

const turnOf = (...messages: ChatMessage[]): ChatTurn => ({ id: messages[0]!.id, messages, folded: [] });

const write = (id: string, path: string, over: Partial<TranscriptTool> = {}): TranscriptTool => ({
    id,
    name: `Write`,
    category: `edit`,
    status: `completed`,
    locations: [{ path }],
    ...over,
});

// A command whose card the daemon named its documents on.
const command = (id: string, paths: readonly string[], over: Partial<TranscriptTool> = {}): TranscriptTool => ({
    id,
    name: `Bash`,
    category: `execute`,
    status: `completed`,
    target: `python build.py`,
    locations: paths.map((path) => ({ path })),
    ...over,
});

describe(`deliverablesOfTurn`, () => {
    it(`lists what edits and commands wrote, a delegation's own included, in the order they were written`, () => {
        const prompt = row({ role: `user`, text: `make the board pack` });
        const turn = turnOf(
            prompt,
            row({ role: `assistant`, tools: [write(`w1`, `site/index.html`), command(`b1`, [`out/q3.pptx`, `out/q3.pdf`])] }),
            row({
                role: `assistant`,
                tools: [{ id: `a1`, name: `Agent`, category: `other`, status: `completed`, children: [command(`b2`, [`out/figures.xlsx`])] }],
            }),
        );
        expect(deliverablesOfTurn(turn)).toEqual([
            { path: `site/index.html`, kind: `html`, turnId: prompt.id },
            { path: `out/q3.pptx`, kind: `pptx`, turnId: prompt.id },
            { path: `out/q3.pdf`, kind: `pdf`, turnId: prompt.id },
            { path: `out/figures.xlsx`, kind: `xlsx`, turnId: prompt.id },
        ]);
    });

    it(`reads an edit's diff where the card carries no location, and folds a leading ./`, () => {
        const turn = turnOf(
            row({ role: `user`, text: `fix the letter` }),
            row({
                role: `assistant`,
                tools: [
                    write(`w1`, `x`, { locations: undefined, content: [{ type: `diff`, path: `letters/reply.docx`, newText: `` }] }),
                    command(`b1`, [`./letters/reply.docx`]),
                ],
            }),
        );
        expect(deliverablesOfTurn(turn).map((entry) => entry.path)).toEqual([`letters/reply.docx`]);
    });

    it(`keeps a document written twice once, where it was last written`, () => {
        const turn = turnOf(
            row({ role: `user`, text: `redo it` }),
            row({ role: `assistant`, tools: [command(`b1`, [`deck.pptx`]), write(`w1`, `notes.html`)] }),
            row({ role: `assistant`, tools: [command(`b2`, [`deck.pptx`])] }),
        );
        expect(deliverablesOfTurn(turn).map((entry) => entry.path)).toEqual([`notes.html`, `deck.pptx`]);
    });

    it(`leaves out a failed edit, a read, a document deleted afterwards, and every file that is not a document`, () => {
        const turn = turnOf(
            row({ role: `user`, text: `tidy up` }),
            row({
                role: `assistant`,
                tools: [
                    write(`w1`, `draft.docx`, { status: `failed` }),
                    { id: `r1`, name: `Read`, category: `read`, status: `completed`, locations: [{ path: `brief.pdf` }] },
                    command(`b1`, [`old.pdf`, `build.py`]),
                    write(`w2`, `src/app.ts`),
                    write(`w3`, `README.md`),
                ],
            }),
            row({ role: `assistant`, tools: [{ id: `d1`, name: `Delete`, category: `delete`, status: `completed`, locations: [{ path: `old.pdf` }] }] }),
        );
        expect(deliverablesOfTurn(turn)).toEqual([]);
    });

    it(`counts a command that failed after writing its file, and not one still running`, () => {
        const turn = turnOf(
            row({ role: `user`, text: `export it` }),
            row({ role: `assistant`, tools: [command(`b1`, [`export.xlsx`], { status: `failed` }), command(`b2`, [`later.pdf`], { status: `in_progress` })] }),
        );
        expect(deliverablesOfTurn(turn).map((entry) => entry.path)).toEqual([`export.xlsx`]);
    });
});

describe(`deliverablesByTurn`, () => {
    it(`hands a turn whose documents did not change the array it had, and a changed one a new array`, () => {
        const first = turnOf(row({ role: `user`, text: `a` }), row({ role: `assistant`, tools: [write(`w1`, `a.html`)] }));
        const second = turnOf(row({ role: `user`, text: `b` }), row({ role: `assistant`, tools: [write(`w2`, `b.html`)] }));
        const before = deliverablesByTurn([first, second], undefined);
        const grown = turnOf(...second.messages, row({ role: `assistant`, tools: [command(`b1`, [`b.pdf`])] }));
        const after = deliverablesByTurn([first, grown], before);
        expect(after.get(first.id)).toBe(before.get(first.id));
        expect(after.get(grown.id)?.map((entry) => entry.path)).toEqual([`b.html`, `b.pdf`]);
    });
});

describe(`deliverableName`, () => {
    it(`is the file's own name with its extension, which says what opens it`, () => {
        expect(deliverableName(`board/q3/Board pack.pptx`)).toBe(`Board pack.pptx`);
        expect(deliverableName(`report.pdf`)).toBe(`report.pdf`);
    });
});
