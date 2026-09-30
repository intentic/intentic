import type { AttachFrame, TranscriptTool } from "@intentic/sandbox-contract";
import { applyPatch, attachRun, emptyTranscriptState, rebuildKeeping } from "./transcriptState";

const child: TranscriptTool = { id: `t2`, name: `Read`, category: `read`, status: `in_progress` };
const delegation: TranscriptTool = { id: `task-1`, name: `Agent`, category: `other`, status: `in_progress`, thinking: `in`, children: [child] };
const head: Extract<AttachFrame, { kind: "attached" }> = {
    kind: `attached`,
    run: `run-1`,
    startedAt: 1,
    seq: 0,
    rows: [{ role: `assistant`, text: ``, tools: [delegation] }],
};

describe(`applyPatch`, () => {
    it(`appends a subagent's reasoning onto the card that started it`, () => {
        const state = applyPatch(attachRun(emptyTranscriptState, head), { op: `toolThinking`, index: 0, id: `task-1`, text: `ner` }, false);
        expect(state.messages[0]?.tools?.[0]?.thinking).toBe(`inner`);
    });

    it(`updates a card's own fields and keeps the calls and reasoning nested under it`, () => {
        const state = applyPatch(
            attachRun(emptyTranscriptState, head),
            { op: `tool`, index: 0, tool: { id: `task-1`, name: `Agent`, category: `other`, status: `completed` } },
            false,
        );
        expect(state.messages[0]?.tools?.[0]).toEqual({ ...delegation, status: `completed` });
    });
});

// A subagent's reasoning arrives a token at a time as its words alone, and must land on the card that spawned it
// wherever that card nests, leaving every other card as it was.
test(`a subagent's reasoning lands on the card that spawned it, however deep it nests`, () => {
    const spawner = { id: `task-1`, name: `Agent`, category: `other` as const, status: `in_progress` as const, thinking: `looking` };
    const nested = { id: `task-2`, name: `Agent`, category: `other` as const, status: `in_progress` as const };
    const attached = attachRun(emptyTranscriptState, {
        kind: `attached`,
        run: `run-1`,
        startedAt: 0,
        seq: 0,
        rows: [{ role: `assistant`, text: ``, run: `run-1`, tools: [{ ...spawner, children: [nested] }] }],
    });

    const onTop = applyPatch(attached, { op: `toolThinking`, index: 0, id: `task-1`, text: ` for the handler` }, false);
    expect(onTop.messages[0]?.tools?.[0]?.thinking).toBe(`looking for the handler`);
    const deep = applyPatch(onTop, { op: `toolThinking`, index: 0, id: `task-2`, text: `inner` }, false);
    expect(deep.messages[0]?.tools?.[0]?.children?.[0]?.thinking).toBe(`inner`);
    expect(deep.messages[0]?.tools?.[0]?.thinking).toBe(`looking for the handler`);
    // A card nobody holds leaves the row as it was.
    expect(applyPatch(deep, { op: `toolThinking`, index: 0, id: `gone`, text: `x` }, false).messages).toEqual(deep.messages);
});

// A redraw of a record already on screen (the daemon's page replacing the mirror's paint, a replay after a reconnect)
// keeps the rows it drew, so nothing unchanged is parsed and laid out again; what is new or changed is allocated above
// every id standing, so a kept row's id is never handed to another.
describe(`rebuildKeeping`, () => {
    it(`keeps the objects of rows whose content is unchanged, and draws the rest anew above every standing id`, () => {
        const asked = { id: 7, role: `user` as const, text: `fix the bug` };
        const answered = { id: 8, role: `assistant` as const, text: `looking` };
        const state = rebuildKeeping(
            [asked, answered],
            [
                { role: `user`, text: `fix the bug` },
                { role: `assistant`, text: `looking at it now` },
                { role: `user`, text: `thanks` },
            ],
        );

        expect(state.messages[0]).toBe(asked);
        expect(state.messages.slice(1)).toEqual([
            { role: `assistant`, text: `looking at it now`, id: 9 },
            { role: `user`, text: `thanks`, id: 10 },
        ]);
        expect(state.nextId).toBe(11);
    });

    it(`matches repeated rows one for one, in order`, () => {
        const first = { id: 1, role: `user` as const, text: `continue` };
        const second = { id: 2, role: `user` as const, text: `continue` };
        const state = rebuildKeeping([first, second], [{ role: `user`, text: `continue` }, { role: `user`, text: `continue` }, { role: `user`, text: `continue` }]);

        expect(state.messages.map((message) => message.id)).toEqual([1, 2, 3]);
        expect(state.messages[1]).toBe(second);
    });

    it(`numbers from one when nothing stands`, () => {
        expect(rebuildKeeping([], [{ role: `user`, text: `hi` }]).messages).toEqual([{ role: `user`, text: `hi`, id: 1 }]);
    });
});
