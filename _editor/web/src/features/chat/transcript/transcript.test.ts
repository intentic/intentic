import { describe, expect, it } from "vitest";
import { holdsRequest, type TodoItem } from "@intentic/sandbox-contract";
import {
    changedNothing,
    type ChatMessage,
    type ChecklistDelta,
    type ChecklistView,
    checklistViewsOf,
    currentChecklist,
    liveBubbleOf,
    recordedRows,
    repeatedChecklistIds,
    turnsOf,
} from "./transcript";

const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];

it(`keeps checklist changes and meaningful intervening messages while hiding only unchanged retry copies`, () => {
    const todos = [{ content: `Build`, status: `pending` as const }];
    const messages: ChatMessage[] = [
        { id: 1, role: `assistant`, text: ``, todos },
        { id: 2, role: `notice`, text: `Usage limit reached` },
        { id: 3, role: `assistant`, text: ``, todos: [...todos] },
        { id: 4, role: `assistant`, text: ``, todos: [{ content: `Build`, status: `completed` }] },
        { id: 5, role: `user`, text: `Try again` },
        { id: 6, role: `assistant`, text: ``, todos },
        { id: 7, role: `assistant`, text: `Working`, todos },
        { id: 8, role: `assistant`, text: ``, todos, question: { requestId: `q1`, questions, status: `pending` } },
    ];
    expect(repeatedChecklistIds(messages)).toEqual(new Set([3]));
    expect(recordedRows(messages)).toBe(8);
});

describe(`recordedRows`, () => {
    // Must match the daemon's own fold: a bubble holding only a card counts, an empty bubble never does, and a notice
    // counts unless this window drew it itself.
    it(`counts a bubble holding nothing but a card, as the daemon's record does`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `choose` },
            { id: 2, role: `assistant`, text: ``, question: { requestId: `q1`, questions, status: `answered` } },
            { id: 3, role: `assistant`, text: `` },
            { id: 4, role: `notice`, text: `Switched to Codex.`, local: true },
            { id: 5, role: `notice`, text: `The provider refused the turn.` },
            { id: 6, role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, status: `cancelled` } },
        ];
        expect(messages.map(holdsRequest)).toEqual([false, true, false, false, false, true]);
        expect(recordedRows(messages)).toBe(4);
    });
});

describe(`liveBubbleOf`, () => {
    it(`finds no bubble while the turn has produced nothing`, () => {
        expect(liveBubbleOf([{ id: 1, role: `user`, text: `go` }])).toBeUndefined();
    });

    it(`does not mistake the previous turn's answer for the live one`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `first` },
            { id: 2, role: `assistant`, text: `done` },
            { id: 3, role: `user`, text: `second` },
        ];
        expect(liveBubbleOf(messages)).toBeUndefined();
    });

    it(`is the bubble the turn is writing into once it has opened one`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `first` },
            { id: 2, role: `assistant`, text: `done` },
            { id: 3, role: `user`, text: `second` },
            { id: 4, role: `assistant`, text: `working` },
        ];
        expect(liveBubbleOf(messages)?.id).toBe(4);
    });

    it(`steps over a notice drawn under the live bubble`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `go` },
            { id: 2, role: `assistant`, text: `working` },
            { id: 3, role: `notice`, text: `Switched to Codex.`, local: true },
        ];
        expect(liveBubbleOf(messages)?.id).toBe(2);
    });

    it(`treats a mid-turn steer as leaving the turn without a bubble`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `go` },
            { id: 2, role: `assistant`, text: `working` },
            { id: 3, role: `user`, text: `actually, do it this way` },
        ];
        expect(liveBubbleOf(messages)).toBeUndefined();
    });
});

const task = (content: string, status: TodoItem["status"], activeForm?: string): TodoItem => ({
    content,
    status,
    ...(activeForm !== undefined ? { activeForm } : {}),
});

// One turn's worth of what the daemon actually emits: the whole list again on every status flip, so three tasks cost
// twelve rows to say four things.
const SNAPSHOTS: TodoItem[][] = [
    [task(`Share the skin`, `in_progress`, `Sharing the skin`), task(`Give the typefaces`, `pending`), task(`Redesign the face`, `pending`)],
    [task(`Share the skin`, `completed`), task(`Give the typefaces`, `in_progress`, `Giving the typefaces`), task(`Redesign the face`, `pending`)],
    [task(`Share the skin`, `completed`), task(`Give the typefaces`, `completed`), task(`Redesign the face`, `in_progress`, `Redesigning the face`)],
    [task(`Share the skin`, `completed`), task(`Give the typefaces`, `completed`), task(`Redesign the face`, `completed`)],
];

const TURN: ChatMessage[] = [
    { id: 1, role: `user`, text: `redo the setup window` },
    { id: 2, role: `assistant`, text: `Found it.`, todos: SNAPSHOTS[0] },
    { id: 3, role: `assistant`, text: `Now the scaffolding.`, todos: SNAPSHOTS[1] },
    { id: 4, role: `assistant`, text: `Now the stylesheet.`, todos: SNAPSHOTS[2] },
    { id: 5, role: `assistant`, text: `That is the face.`, todos: SNAPSHOTS[3] },
];

const viewsOf = (messages: readonly ChatMessage[], repeated: ReadonlySet<number> = new Set()): Map<number, ChecklistView> =>
    checklistViewsOf(turnsOf([...messages]), repeated);

describe(`checklistViewsOf`, () => {
    it(`draws the list at both ends of a turn and only what moved in between`, () => {
        const views = viewsOf(TURN);
        expect(views.get(2)).toEqual({ kind: `full` });

        const second = views.get(3)!;
        expect(second.kind).toBe(`delta`);
        const moved = second as ChecklistDelta;
        expect(moved.finished.map((item) => item.content)).toEqual([`Share the skin`]);
        expect(moved.started.map((item) => item.content)).toEqual([`Give the typefaces`]);
        expect([moved.doneBefore, moved.done, moved.total]).toEqual([0, 1, 3]);

        // Read top-down, the opener is the turn's most prominent row and its least true by the end, with everything
        // after it a one-liner. So the turn ends on the list as well: what is still standing, where the reader stops.
        expect(views.get(5)).toEqual({ kind: `full` });

        // Still the point, counted: twelve rows for four facts becomes eight lines.
        const lines = [...views.values()].reduce((total, view) => total + (view.kind === `full` ? SNAPSHOTS[0]!.length : 1), 0);
        expect(lines).toBe(8);
    });

    it(`ends a turn on the last snapshot that MOVED something, never on a resync that restated it`, () => {
        const views = viewsOf([...TURN, { id: 6, role: `assistant`, text: `Checking.`, todos: [...SNAPSHOTS[3]!] }]);
        expect(views.get(5)).toEqual({ kind: `full` });
        expect(changedNothing(views.get(6)!)).toBe(true);
    });

    it(`names the task a snapshot moved on from without finishing, which a count alone reads as progress stalling`, () => {
        const handover = [task(`Share the skin`, `completed`), task(`Give the typefaces`, `pending`), task(`Redesign the face`, `in_progress`)];
        const views = viewsOf([
            ...TURN.slice(0, 3),
            { id: 4, role: `assistant`, text: `Parking that one.`, todos: handover },
            { id: 5, role: `assistant`, text: `Done.`, todos: SNAPSHOTS[3] },
        ]);
        const moved = views.get(4) as ChecklistDelta;
        expect(moved.parked.map((item) => item.content)).toEqual([`Give the typefaces`]);
        expect(moved.finished).toEqual([]);
        expect([moved.doneBefore, moved.done]).toEqual([1, 1]);
    });

    it(`restates the whole list when a new prompt starts a turn`, () => {
        const views = viewsOf([
            ...TURN,
            { id: 6, role: `user`, text: `now the other states` },
            { id: 7, role: `assistant`, text: `Looking.`, todos: SNAPSHOTS[2] },
        ]);
        expect(views.get(7)).toEqual({ kind: `full` });
    });

    it(`counts a task that appears mid-turn, which no pair of moved rows can say`, () => {
        const grown = [...SNAPSHOTS[3]!, task(`Calm the card`, `pending`)];
        const views = viewsOf([
            ...TURN,
            { id: 6, role: `assistant`, text: `One more.`, todos: grown },
            { id: 7, role: `assistant`, text: `And that.`, todos: [...SNAPSHOTS[3]!, task(`Calm the card`, `completed`)] },
        ]);
        const moved = views.get(6) as ChecklistDelta;
        expect([moved.added, moved.dropped, moved.total]).toEqual([1, 0, 4]);
    });

    it(`has no line to draw for a resync that restates what is already on screen`, () => {
        const views = viewsOf([...TURN, { id: 6, role: `assistant`, text: `Checking.`, todos: [...SNAPSHOTS[3]!] }]);
        expect(changedNothing(views.get(6)!)).toBe(true);
        expect(changedNothing(views.get(2)!)).toBe(false);
    });

    it(`skips a snapshot the transcript never draws, so the next delta measures against what was drawn`, () => {
        const views = viewsOf(TURN, new Set([3]));
        expect(views.has(3)).toBe(false);
        const moved = views.get(4) as ChecklistDelta;
        expect(moved.finished.map((item) => item.content)).toEqual([`Share the skin`, `Give the typefaces`]);
        expect(moved.started.map((item) => item.content)).toEqual([`Redesign the face`]);
    });
});

describe(`currentChecklist`, () => {
    it(`is the last snapshot of the turn in progress`, () => {
        expect(currentChecklist(TURN)).toBe(SNAPSHOTS[3]);
    });

    it(`clears once a later prompt has worked without one, rather than pinning a stale list`, () => {
        const after: ChatMessage[] = [...TURN, { id: 6, role: `user`, text: `what is in this file?` }, { id: 7, role: `assistant`, text: `A stylesheet.` }];
        expect(currentChecklist(after)).toBeUndefined();
    });

    it(`survives a bare nudge, which folds into the turn rather than starting one`, () => {
        const nudged: ChatMessage[] = [...TURN, { id: 6, role: `user`, text: `continue` }, { id: 7, role: `assistant`, text: `Carrying on.` }];
        expect(currentChecklist(nudged)).toBe(SNAPSHOTS[3]);
    });
});
