import type { AttachFrame, TranscriptTool } from "@intentic/sandbox-contract";
import { applyPatch, attachRun, emptyTranscriptState } from "./transcriptState";

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
