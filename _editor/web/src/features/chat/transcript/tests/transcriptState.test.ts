import type { AgentEvent, AttachFrame } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import {
    applyPatch,
    attachRun,
    emptyTranscriptState,
    mergeRecorded,
    positioned,
    rebuildKeeping,
    recordCursor,
    type TranscriptState,
} from "../../../../models/conversations/transcript/transcriptState";

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
// The rows a window draws from a run's patches are the rows the run records, so a chat followed live and the same chat
// reopened from its record are one transcript: what a patch does to a row is the contract's rule, never this window's.
test(`a window following a run's patches holds exactly the rows its fold records`, () => {
    const opening = [userRow(`go`, 1, [])];
    const fold = new TranscriptFold(opening);
    const frames: AgentEvent[] = [
        { kind: `thinking`, text: `look` },
        { kind: `delta`, text: `Reading ` },
        { kind: `delta`, text: `it.` },
        { kind: `text_end` },
        { kind: `tool_call`, id: `task-1`, name: `Agent`, category: `other`, status: `in_progress` },
        { kind: `tool_call`, id: `t2`, name: `Read`, category: `read`, status: `in_progress`, parentToolUseId: `task-1` },
        { kind: `thinking`, text: `inner`, parentToolUseId: `task-1` },
        { kind: `tool_call_update`, id: `t2`, status: `completed` },
        { kind: `tool_call_update`, id: `task-1`, status: `completed` },
        { kind: `todos`, items: [{ content: `a`, status: `pending` }] },
        { kind: `delta`, text: `Done.` },
        { kind: `text_end` },
        { kind: `tool_call`, id: `t3`, name: `Bash`, category: `execute`, status: `in_progress` },
    ];
    let state = attachRun(emptyTranscriptState, { kind: `attached`, run: `run-1`, startedAt: 1, seq: 0, rows: opening });
    for (const patch of [...frames.flatMap((frame) => fold.apply(frame)), ...fold.finish(`settled`)]) {
        state = applyPatch(state, patch, false);
    }
    const drawn: TranscriptRow[] = state.messages.map(({ id: _id, ...row }) => row);
    expect(drawn).toEqual(fold.rows);
    expect(drawn.map((row) => row.role)).toEqual([`user`, `assistant`, `assistant`, `assistant`]);
});

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
// keeps the rows it drew, so nothing unchanged is parsed and laid out again. Named prompts keep their keys under fresh
// rewind metadata, so their turns stay mounted; unmatched rows allocate above every standing id.
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
        const state = rebuildKeeping(
            [first, second],
            [
                { role: `user`, text: `continue` },
                { role: `user`, text: `continue` },
                { role: `user`, text: `continue` },
            ],
        );

        expect(state.messages.map((message) => message.id)).toEqual([1, 2, 3]);
        expect(state.messages[1]).toBe(second);
    });

    it(`keeps a named prompt's id as fresh checkpoint metadata arrives, changes, and disappears`, () => {
        const prompt = { role: `user` as const, text: `fix the bug`, messageId: `prompt-1`, run: `run-1` };
        const asked = { ...prompt, id: 7 };
        const reply = { role: `assistant` as const, text: `looking`, run: `run-1` };
        const answered = { ...reply, id: 8 };
        let standing: readonly ChatMessage[] = [asked, answered];

        for (const checkpoint of [{ checkpointId: `cp-1`, rewindIndex: 0 }, { checkpointId: `cp-2`, rewindIndex: 4 }, {}]) {
            const row = { ...prompt, ...checkpoint };
            const state = rebuildKeeping(standing, [row, reply]);

            expect(state.messages[0]).toEqual({ ...row, id: 7 });
            expect(state.messages[1]).toBe(answered);
            expect(state.nextId).toBe(9);
            standing = state.messages;
        }
    });

    it(`keeps the object of an unchanged named prompt`, () => {
        const prompt = { role: `user` as const, text: `fix the bug`, messageId: `prompt-1` };
        const asked = { ...prompt, id: 7 };

        expect(rebuildKeeping([asked], [prompt]).messages[0]).toBe(asked);
    });

    it(`matches named prompts by identity, not repeated words or their position`, () => {
        const first = { role: `user` as const, text: `Continue`, messageId: `prompt-1` };
        const second = { ...first, messageId: `prompt-2` };
        const third = { ...first, messageId: `prompt-3` };
        const state = rebuildKeeping(
            [{ ...first, id: 7 }, { ...second, id: 8 }],
            [{ ...second, checkpointId: `cp-2`, rewindIndex: 0 }, { ...first, checkpointId: `cp-1`, rewindIndex: 2 }, third],
        );

        expect(state.messages).toEqual([
            { ...second, checkpointId: `cp-2`, rewindIndex: 0, id: 8 },
            { ...first, checkpointId: `cp-1`, rewindIndex: 2, id: 7 },
            { ...third, id: 9 },
        ]);
        expect(state.nextId).toBe(10);
    });

    it(`takes a named prompt's authoritative words without changing its key or retaining withdrawn fields`, () => {
        const asked = { role: `user` as const, text: `old words`, messageId: `prompt-1`, attachments: [`old.png`], id: 7 };
        const refreshed = { role: `user` as const, text: `authoritative words`, messageId: `prompt-1` };
        const state = rebuildKeeping([asked], [refreshed]);

        expect(state.messages[0]).toEqual({ ...refreshed, id: 7 });
        expect(state.messages[0]).not.toBe(asked);
        expect(state.nextId).toBe(8);
    });

    it(`never gives a named prompt's standing id to more than one incoming row`, () => {
        const prompt = { role: `user` as const, text: `Continue`, messageId: `prompt-1` };
        const refreshed = { ...prompt, checkpointId: `cp-1`, rewindIndex: 0 };
        const state = rebuildKeeping([{ ...prompt, id: 7 }], [refreshed, refreshed]);

        expect(state.messages).toEqual([{ ...refreshed, id: 7 }, { ...refreshed, id: 8 }]);
        expect(state.nextId).toBe(9);
    });

    it(`numbers from one when nothing stands`, () => {
        expect(rebuildKeeping([], [{ role: `user`, text: `hi` }]).messages).toEqual([{ role: `user`, text: `hi`, id: 1 }]);
    });
});

// A ROW IS ITSELF ACROSS EVERY COPY OF IT. Rows from a sandbox that names them (TranscriptRow.rowId) are matched by that
// name: a patch lands on its row wherever it sits, a redraw keeps the row's id whatever its contents became, and what the
// record gained since this window's cursor is added in place rather than the whole record drawn again.
describe(`row ids`, () => {
    const live = (rows: ChatMessage[]): TranscriptState => ({ ...emptyTranscriptState, messages: rows, nextId: Math.max(0, ...rows.map((row) => row.id)) + 1 });

    it(`lands a patch on the row it names, whatever index the run counts it at`, () => {
        // A notice this window drew sits inside the run's rows, so counting from the run's first row lands one short.
        const state: TranscriptState = {
            ...live([
                { id: 1, role: `user`, text: `fix it`, rowId: `u1`, run: `r1` },
                { id: 2, role: `notice`, text: `switched`, local: true },
                { id: 3, role: `assistant`, text: `on it`, rowId: `a1`, run: `r1` },
            ]),
            attached: { run: `r1`, base: 0 },
        };
        const patched = applyPatch(state, { op: `text`, index: 1, rowId: `a1`, text: `, now` }, false);
        expect(patched.messages.map((message) => message.text)).toEqual([`fix it`, `switched`, `on it, now`]);
    });

    it(`keeps a row's id through a redraw that changed its contents, and its object where nothing changed`, () => {
        const asked = { id: 4, role: `user` as const, text: `fix it`, rowId: `u1`, at: 0 };
        const answered = { id: 5, role: `assistant` as const, text: `on it`, rowId: `a1` };
        const state = rebuildKeeping([asked, answered], positioned([{ role: `user`, text: `fix it`, rowId: `u1` }, { role: `assistant`, text: `on it, done`, rowId: `a1` }], 0));
        expect(state.messages[0]).toBe(asked);
        expect(state.messages[1]).toEqual({ id: 5, role: `assistant`, text: `on it, done`, rowId: `a1`, at: 1 });
    });

    it(`reads the cursor off the last row the record holds, past a live run and this window's own rows`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `fix it`, rowId: `u1`, at: 7 },
            { id: 2, role: `assistant`, text: `on it`, rowId: `a1`, at: 8 },
            { id: 3, role: `user`, text: `and the docs`, rowId: `u2`, run: `r2` },
            { id: 4, role: `user`, text: `later`, local: true, unsent: true },
        ];
        expect(recordCursor(messages)).toEqual({ after: 9, afterRow: `a1` });
        // A record row with no id (a sandbox from before ids) leaves no cursor: only a whole read catches up then.
        expect(recordCursor([{ id: 1, role: `user`, text: `fix it`, at: 0 }])).toBeUndefined();
        expect(recordCursor([])).toBeUndefined();
    });

    it(`adds what the record gained after the cursor's row, above a live run's rows and below the rest of the record`, () => {
        const state = live([
            { id: 1, role: `user`, text: `fix it`, rowId: `u1`, at: 0 },
            { id: 2, role: `assistant`, text: `on it`, rowId: `a1`, at: 1 },
            { id: 3, role: `user`, text: `now the docs`, rowId: `u3`, run: `r3` },
        ]);
        // Another window ran a turn (r2) this one never saw; r3 is live here and not on the record yet.
        const merged = mergeRecorded(state, positioned([{ role: `user`, text: `and the tests`, rowId: `u2`, run: `r2` }, { role: `assistant`, text: `done`, rowId: `a2`, run: `r2` }], 2), `a1`);
        expect(merged?.messages.map((message) => [message.id, message.text, message.at])).toEqual([
            [1, `fix it`, 0],
            [2, `on it`, 1],
            [4, `and the tests`, 2],
            [5, `done`, 3],
            [3, `now the docs`, undefined],
        ]);
        expect(merged?.nextId).toBe(6);
    });

    it(`takes a live run's recorded copy in place, under the id it was drawn with, ahead of this window's own rows`, () => {
        const reply = { id: 2, role: `assistant` as const, text: `done`, rowId: `a1`, run: `r1` };
        const state = live([{ id: 1, role: `user`, text: `fix it`, rowId: `u1`, run: `r1` }, { id: 3, role: `notice`, text: `Stopped.`, local: true }, reply]);
        const merged = mergeRecorded(
            { ...live([{ id: 9, role: `user`, text: `before`, rowId: `u0`, at: 4 }, ...state.messages]), nextId: 10 },
            positioned(
                [
                    { role: `user`, text: `fix it`, rowId: `u1`, run: `r1`, checkpointId: `cp-1`, rewindIndex: 5 },
                    { role: `assistant`, text: `done`, rowId: `a1`, run: `r1` },
                ],
                5,
            ),
            `u0`,
        );
        expect(merged?.messages.map((message) => [message.id, message.at, message.checkpointId])).toEqual([
            [9, 4, undefined],
            [1, 5, `cp-1`],
            [2, 6, undefined],
            [3, undefined, undefined],
        ]);
        // Nothing new was drawn: every row kept the id it was drawn under.
        expect(merged?.nextId).toBe(10);
    });

    it(`cannot add after a row this window no longer holds`, () => {
        const state = live([{ id: 1, role: `user`, text: `fix it`, rowId: `u1`, at: 0 }]);
        expect(mergeRecorded(state, positioned([{ role: `assistant`, text: `on it`, rowId: `a1` }], 1), `gone`)).toBeUndefined();
        // Nothing gained is nothing changed.
        expect(mergeRecorded(state, [], `u1`)).toBe(state);
    });
});
