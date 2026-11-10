import type { ChatMessage, ChatTurn } from "../../../../models/conversations/transcript/transcript";
import { stepGroupsOf, stepsFold } from "./stepGroups";

const job = (id: number): ChatMessage => ({
    id, role: `notice`, text: `Background job ${id}`,
    backgroundJob: { id: `job-${id}`, label: `Check ${id}`, command: `check ${id}`, startedAt: id * 1000 },
});
const calls = (id: number, text = ``): ChatMessage => ({
    id, role: `assistant`, text,
    tools: [{ id: `tool-${id}`, name: `Bash`, category: `execute`, status: `completed` }],
});
const turn = (...messages: ChatMessage[]): ChatTurn => ({ id: messages[0]!.id, messages, folded: [] });
const groups = (turns: readonly ChatTurn[], cuts = new Map<number, number>(), doomed = new Set<number>(), live?: number) => {
    const result = stepGroupsOf(turns, cuts, doomed, live);
    return {
        heads: [...result.heads].map(([id, group]) => [id, group.members.map((member) => member.id), group.tail?.id]),
        folded: [...result.folded],
    };
};

it(`combines adjacent starts in transcript order without changing their records`, () => {
    const rows = [job(1), job(2), job(3)];
    const result = stepGroupsOf([turn(...rows)], new Map(), new Set());
    expect(result.heads.get(1)!.members).toEqual(rows);
    expect(result.heads.get(1)!.members[1]).toBe(rows[1]);
    expect([...result.folded]).toEqual([2, 3]);
});

it(`stands jobs and the rows of calls between them as one group, with the reply they led to as its tail`, () => {
    const result = stepGroupsOf([turn(job(1), calls(2), job(3), calls(4), calls(5, `Done.`))], new Map(), new Set());
    expect(groups([turn(job(1), calls(2), job(3), calls(4), calls(5, `Done.`))])).toEqual({ heads: [[1, [1, 2, 3, 4], 5]], folded: [2, 3, 4] });
    expect(result.tails.get(5)).toBe(result.heads.get(1));
});

it(`merges one step into the reply after it, and leaves a reply with no run of its own alone`, () => {
    expect(groups([turn(job(1), calls(2, `Done.`))])).toEqual({ heads: [[1, [1], 2]], folded: [] });
    expect(groups([turn(job(1), { id: 2, role: `assistant`, text: `Done.` })])).toEqual({ heads: [], folded: [] });
    expect(groups([turn(calls(1, `First.`), calls(2, `Second.`))])).toEqual({ heads: [], folded: [] });
});

it(`leaves a lone job alone and never groups across prose, notices, or prompts`, () => {
    for (const role of [`assistant`, `notice`, `user`] as const) {
        expect(groups([turn(job(1), { id: 2, role, text: `Interruption` }, job(3), job(4))])).toEqual({
            heads: [[3, [3, 4], undefined]], folded: [4],
        });
    }
    expect(groups([turn(job(1))])).toEqual({ heads: [], folded: [] });
});

it(`keeps the row still being written out of every group`, () => {
    expect(groups([turn(job(1), calls(2), calls(3))], new Map(), new Set(), 3)).toEqual({ heads: [[1, [1, 2], undefined]], folded: [2] });
    expect(groups([turn(job(1), calls(2, `Writing…`))], new Map(), new Set(), 2)).toEqual({ heads: [], folded: [] });
});

it(`keeps turns, fork cuts, and edit strikeouts separate`, () => {
    expect(groups([turn(job(1), job(2)), turn(job(3), job(4))])).toEqual({
        heads: [[1, [1, 2], undefined], [3, [3, 4], undefined]], folded: [2, 4],
    });
    const rows = [turn(job(1), job(2), job(3), job(4))];
    const separated = { heads: [[1, [1, 2], undefined], [3, [3, 4], undefined]], folded: [2, 4] };
    expect(groups(rows, new Map([[3, 2]]))).toEqual(separated);
    expect(groups(rows, new Map(), new Set([3, 4]))).toEqual(separated);
    expect(groups([turn(job(1), calls(2, `Done.`))], new Map([[2, 1]]))).toEqual({ heads: [], folded: [] });
});

it(`preserves a job's context notes as their own row`, () => {
    const withNotes = { ...job(2), notes: [{ title: `Context`, text: `Read this first` }] };
    expect(groups([turn(job(1), withNotes, job(3), job(4))])).toEqual({
        heads: [[3, [3, 4], undefined]], folded: [4],
    });
});

it(`folds only with tool calls hidden and every job over`, () => {
    const group = stepGroupsOf([turn(job(1), calls(2))], new Map(), new Set()).heads.get(1)!;
    const over = [{ id: `job-1`, label: `Check 1`, session: `s`, startedAt: 1000, endedAt: 2000, exitCode: 0 }];
    expect(stepsFold(group, over, false)).toBe(true);
    expect(stepsFold(group, undefined, false)).toBe(true);
    expect(stepsFold(group, over, true)).toBe(false);
    expect(stepsFold(group, [{ id: `job-1`, label: `Check 1`, session: `s`, startedAt: 1000 }], false)).toBe(false);
});
