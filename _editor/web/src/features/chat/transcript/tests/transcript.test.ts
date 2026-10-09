import { holdsRequest, type TodoItem } from "@intentic/sandbox-contract";
import {
    changedNothing,
    type ChatMessage,
    type ChecklistDelta,
    type ChecklistView,
    checklistViewsOf,
    CONTINUATIONS,
    continuationKind,
    currentChecklist,
    lastTurns,
    liveBubbleOf,
    recordedRows,
    repeatedChecklistIds,
    turnsOf,
    unsaidError,
} from "../transcript";

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
        const after: ChatMessage[] = [
            ...TURN,
            { id: 6, role: `user`, text: `what is in this file?` },
            { id: 7, role: `assistant`, text: `A stylesheet.` },
        ];
        expect(currentChecklist(after)).toBeUndefined();
    });

    it(`survives a bare nudge, which folds into the turn rather than starting one`, () => {
        const nudged: ChatMessage[] = [...TURN, { id: 6, role: `user`, text: `continue` }, { id: 7, role: `assistant`, text: `Carrying on.` }];
        expect(currentChecklist(nudged)).toBe(SNAPSHOTS[3]);
    });
});

// The reproduction: Google's "Verify your account to continue." drawn once as the daemon's notice and again, word for
// word, as the window's error line under it.
it(`draws a failure once: the error line gives way to the notice that already says it, not to one that says less`, () => {
    const said = `Verify your account to continue.`;
    const rows: ChatMessage[] = [
        { id: 1, role: `user`, text: `hi` },
        { id: 2, role: `notice`, text: said },
    ];
    expect(unsaidError(said, rows)).toBeUndefined();
    // The notice may carry a clause of the daemon's own after the sentence.
    expect(unsaidError(said, [...rows.slice(0, 1), { id: 2, role: `notice`, text: `${said} Retried 3 of 3 times by itself.` }])).toBeUndefined();
    // An error line with words the notice lacks, or with no notice under the turn, still shows.
    const more = `${said} Install a newer engine under Sandbox ▸ Environment.`;
    expect(unsaidError(more, rows)).toBe(more);
    expect(unsaidError(said, rows.slice(0, 1))).toBe(said);
    expect(unsaidError(null, rows)).toBeUndefined();
});

// The press on Continue sends English the agent reads; the bubble shows it in the reader's language, so the transcript
// has to know the app's own words exactly, and never mistake a person's for them.
it(`names the app's own continuations word for word, and nothing a person typed`, () => {
    expect(continuationKind(CONTINUATIONS.plain)).toBe(`plain`);
    expect(continuationKind(CONTINUATIONS.afterDenial)).toBe(`afterDenial`);
    expect(continuationKind(`continue`)).toBe(undefined);
    expect(continuationKind(`Continue, but skip the tests`)).toBe(undefined);
});

// A streamed reply regroups the transcript on every frame: the turns it did not touch must come back as the same objects,
// or every settled row keyed on them redraws per frame.
describe(`turnsOf across frames`, () => {
    const asked: ChatMessage = { id: 1, role: `user`, text: `fix it` };
    const answered: ChatMessage = { id: 2, role: `assistant`, text: `done` };
    const again: ChatMessage = { id: 3, role: `user`, text: `and the test` };

    it(`hands back a turn whose rows are the very same objects, and rebuilds the one that grew`, () => {
        const writing: ChatMessage = { id: 4, role: `assistant`, text: `on it` };
        const first = turnsOf([asked, answered, again, writing]);
        const grown: ChatMessage = { ...writing, text: `on it, running` };
        const next = turnsOf([asked, answered, again, grown], first);

        expect(next[0]).toBe(first[0]);
        expect(next[1]).not.toBe(first[1]);
        expect(next[1]?.messages).toEqual([again, grown]);
    });

    it(`gives a turn back a row appended to it rather than standing it unchanged`, () => {
        const first = turnsOf([asked, answered, again]);
        const more: ChatMessage = { id: 4, role: `assistant`, text: `on it` };
        const next = turnsOf([asked, answered, again, more], first);
        expect(next[0]).toBe(first[0]);
        expect(next[1]?.messages).toEqual([again, more]);
    });

    // Every way a transcript changes between two groupings, against grouping from scratch: the reused turns must be the
    // grouping a fresh read would make, only kept as the same objects.
    it(`groups exactly as a fresh read does, whatever changed`, () => {
        let state = 7;
        const next = (): number => {
            state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
            return state / 2_147_483_648;
        };
        let id = 0;
        const row = (): ChatMessage => {
            id += 1;
            const pick = next();
            if (pick < 0.25) {
                return { id, role: `user`, text: `prompt ${id}` };
            }
            if (pick < 0.3) {
                return { id, role: `user`, text: `continue` };
            }
            return pick < 0.4 ? { id, role: `notice`, text: `note ${id}` } : { id, role: `assistant`, text: `answer ${id}` };
        };
        let rows: ChatMessage[] = [];
        let turns = turnsOf(rows);
        const shape = (grouped: readonly { messages: readonly ChatMessage[]; folded: readonly ChatMessage[] }[]) =>
            grouped.map((turn) => [turn.messages.map((message) => message.id), turn.folded.map((message) => message.id)]);
        for (let step = 0; step < 500; step += 1) {
            const pick = next();
            const at = Math.floor(next() * rows.length);
            // A new array every step, as every change to a transcript is: the reuse is by row identity.
            if (pick < 0.5 || rows.length === 0) {
                rows = rows.concat([row()]);
            } else if (pick < 0.75) {
                rows = rows.map((message, index) => (index === rows.length - 1 ? { ...message, text: `${message.text}.` } : message));
            } else if (pick < 0.85) {
                rows = rows.map((message, index) => (index === at ? row() : message));
            } else if (pick < 0.92) {
                rows = rows.filter((_, index) => index !== at);
            } else {
                rows = [row(), row(), ...rows];
            }
            const fresh = turnsOf(rows);
            const reused = turnsOf(rows, turns);
            expect(shape(reused)).toEqual(shape(fresh));
            turns = reused;
        }
    });
});

describe(`checklistViewsOf across frames`, () => {
    it(`keeps a delta equal to the one drawn last frame`, () => {
        const before: TodoItem[] = [{ content: `Build`, status: `in_progress` }];
        const after: TodoItem[] = [{ content: `Build`, status: `completed` }];
        const rows: ChatMessage[] = [
            { id: 1, role: `user`, text: `go` },
            { id: 2, role: `assistant`, text: ``, todos: before },
            { id: 3, role: `assistant`, text: ``, todos: after },
            { id: 4, role: `assistant`, text: ``, todos: [...after] },
        ];
        const first = checklistViewsOf(turnsOf(rows), new Set());
        const next = checklistViewsOf(turnsOf(rows.map((row) => ({ ...row }))), new Set(), first);

        expect([...next.keys()]).toEqual([...first.keys()]);
        expect([...next.entries()].filter(([id, view]) => view !== first.get(id))).toEqual([]);
    });
});

// A phone's first paint of a chat is its last few turns, not the mirror's whole tail.
describe(`lastTurns`, () => {
    const rows: ChatMessage[] = [
        { id: 1, role: `user`, text: `one` },
        { id: 2, role: `assistant`, text: `a` },
        { id: 3, role: `user`, text: `two` },
        { id: 4, role: `assistant`, text: `b` },
        { id: 5, role: `user`, text: `three` },
        { id: 6, role: `assistant`, text: `c` },
    ];

    it(`starts at the prompt of the turn that many turns from the end`, () => {
        expect(lastTurns(rows, 2).map((row) => row.id)).toEqual([3, 4, 5, 6]);
        expect(lastTurns(rows, 1).map((row) => row.id)).toEqual([5, 6]);
    });

    it(`is the whole transcript when it holds no more turns than asked`, () => {
        expect(lastTurns(rows, 3)).toBe(rows);
        expect(lastTurns(rows, 9)).toBe(rows);
    });
});
