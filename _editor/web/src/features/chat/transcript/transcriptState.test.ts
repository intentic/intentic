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
