import type { ChatMessage, ChatTurn } from "../../../../models/conversations/transcript/transcript";
import { jobGroupsOf } from "./jobGroups";

const job = (id: number): ChatMessage => ({
    id, role: `notice`, text: `Background job ${id}`,
    backgroundJob: { id: `job-${id}`, label: `Check ${id}`, command: `check ${id}`, startedAt: id * 1000 },
});
const turn = (...messages: ChatMessage[]): ChatTurn => ({ id: messages[0]!.id, messages, folded: [] });
const groups = (turns: readonly ChatTurn[], cuts = new Map<number, number>(), doomed = new Set<number>()) => {
    const result = jobGroupsOf(turns, cuts, doomed);
    return { heads: [...result.heads].map(([id, jobs]) => [id, jobs.map((entry) => entry.id)]), folded: [...result.folded] };
};

it(`combines adjacent starts in transcript order without changing their records`, () => {
    const rows = [job(1), job(2), job(3)];
    const result = jobGroupsOf([turn(...rows)], new Map(), new Set());
    expect(result.heads.get(1)).toEqual(rows.map((row) => row.backgroundJob!));
    expect(result.heads.get(1)![1]).toBe(rows[1]!.backgroundJob);
    expect([...result.folded]).toEqual([2, 3]);
});

it(`leaves a lone job alone and never groups across prose, notices, or prompts`, () => {
    for (const role of [`assistant`, `notice`, `user`] as const) {
        expect(groups([turn(job(1), { id: 2, role, text: `Interruption` }, job(3), job(4))])).toEqual({
            heads: [[3, [`job-3`, `job-4`]]], folded: [4],
        });
    }
    expect(groups([turn(job(1))])).toEqual({ heads: [], folded: [] });
});

it(`keeps turns, fork cuts, and edit strikeouts separate`, () => {
    expect(groups([turn(job(1), job(2)), turn(job(3), job(4))])).toEqual({
        heads: [[1, [`job-1`, `job-2`]], [3, [`job-3`, `job-4`]]], folded: [2, 4],
    });
    const rows = [turn(job(1), job(2), job(3), job(4))];
    const separated = { heads: [[1, [`job-1`, `job-2`]], [3, [`job-3`, `job-4`]]], folded: [2, 4] };
    expect(groups(rows, new Map([[3, 2]]))).toEqual(separated);
    expect(groups(rows, new Map(), new Set([3, 4]))).toEqual(separated);
});

it(`preserves a job's context notes as their own row`, () => {
    const withNotes = { ...job(2), notes: [{ title: `Context`, text: `Read this first` }] };
    expect(groups([turn(job(1), withNotes, job(3), job(4))])).toEqual({
        heads: [[3, [`job-3`, `job-4`]]], folded: [4],
    });
});
