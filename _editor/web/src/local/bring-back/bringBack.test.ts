import {
    answered,
    type BringBackState,
    chosenPaths,
    firstChosen,
    IDLE,
    type ProjectAnswer,
    projectAnswer,
    type SandboxChange,
    sectionShown,
} from "./bringBack";

// Pins the exchange behind a local window's Bring back section: what the app's `intentic:project` answers read back as,
// and the step each one leaves the section on.

const event = (detail: unknown): CustomEvent => new CustomEvent(`intentic:project`, { detail });

const CHANGES: SandboxChange[] = [
    { path: `notes/plan.md`, kind: `modified`, size: 120 },
    { path: `src/new.ts`, kind: `added` },
    { path: `old.txt`, kind: `deleted` },
];

describe(`reading the app's answer`, () => {
    it(`reads each kind the app sends`, () => {
        const answers: ProjectAnswer[] = [
            { kind: `changes`, result: { ok: true, direction: `to-sandbox`, changes: CHANGES, truncated: true } },
            { kind: `changes`, result: { ok: false, error: `The sandbox is stopped.` } },
            {
                kind: `brought-back`,
                result: { ok: true, point: `rp-1`, applied: [{ path: `src/new.ts`, kind: `added` }], skipped: [{ path: `a`, reason: `b` }] },
            },
            { kind: `restored`, result: { ok: true, restored: 2, skipped: [{ path: `a`, reason: `b` }] } },
            { kind: `direction`, result: { ok: true, direction: `both` } },
            { kind: `error`, verb: `changes`, error: `No machine agent runs on this computer.` },
        ];
        expect(answers.map((detail) => projectAnswer(event(detail)))).toEqual(answers);
    });

    it(`reads a restore whose skipped list it cannot read as one that names none`, () => {
        expect(projectAnswer(event({ kind: `restored`, result: { ok: true, restored: 2, skipped: [`anything`] } }))).toEqual({
            kind: `restored`,
            result: { ok: true, restored: 2 },
        });
    });

    it(`reads nothing out of a shape it has no answer for`, () => {
        const unread = [
            { kind: `changes`, result: { ok: true, direction: `sideways`, changes: [] } },
            { kind: `changes`, result: { ok: true, direction: `both`, changes: [{ path: ``, kind: `added` }] } },
            { kind: `brought-back`, result: { ok: true, applied: [] } },
            { kind: `restored`, result: { ok: false } },
            { kind: `resized`, result: { ok: true } },
            `changes`,
            undefined,
        ];
        expect([...unread.map((detail) => projectAnswer(event(detail))), projectAnswer(new Event(`intentic:project`))]).toEqual(
            Array.from({ length: unread.length + 1 }, () => undefined),
        );
    });
});

describe(`the step an answer leaves`, () => {
    const at = (state: BringBackState, ...answers: ProjectAnswer[]): BringBackState => answers.reduce(answered, state);
    const brought: ProjectAnswer = {
        kind: `brought-back`,
        result: {
            ok: true,
            point: `rp-1`,
            applied: [
                { path: `src/new.ts`, kind: `added` },
                { path: `old.txt`, kind: `deleted` },
            ],
            skipped: [],
        },
    };

    it(`lists the changes and learns the direction from a check`, () => {
        expect(at(IDLE, { kind: `changes`, result: { ok: true, direction: `both`, changes: CHANGES } })).toEqual({
            ...IDLE,
            direction: `both`,
            step: { at: `checked`, changes: CHANGES, truncated: false },
        });
    });

    it(`holds a bring-back's restore point for its Undo, and counts what the restore put back`, () => {
        const afterBring = at(IDLE, brought);
        expect([afterBring.step, at(afterBring, { kind: `restored`, result: { ok: true, restored: 2 } }).step]).toEqual([
            { at: `brought`, point: `rp-1`, count: 2, skipped: [] },
            { at: `restored`, count: 2 },
        ]);
    });

    it(`says why a verb failed, whether the sandbox refused it or it never reached one`, () => {
        const checking: BringBackState = { ...IDLE, step: { at: `checking` } };
        expect([
            at(IDLE, { kind: `brought-back`, result: { ok: false, error: `Disk full.` } }).step,
            at(checking, { kind: `error`, verb: `changes`, error: `No machine agent runs on this computer.` }).step,
        ]).toEqual([
            { at: `failed`, error: `Disk full.` },
            { at: `failed`, error: `No machine agent runs on this computer.` },
        ]);
    });

    // A switch is apart from the step: its failure never costs the reader the receipt holding their Undo.
    it(`switches direction beside the step, and keeps the step when a switch fails`, () => {
        const switching: BringBackState = { ...at(IDLE, brought), direction: `to-sandbox`, switching: true };
        const switched = at(switching, { kind: `direction`, result: { ok: true, direction: `both` } });
        const refused = at(switching, { kind: `direction`, result: { ok: false, error: `The sandbox is stopped.` } });
        const unreached = at(switching, { kind: `error`, verb: `direction`, error: `No machine agent runs on this computer.` });
        expect(
            [switched, refused, unreached].map(({ step, direction, switching: on, switchError }) => [step.at, direction, on, switchError]),
        ).toEqual([
            [`brought`, `both`, false, undefined],
            [`brought`, `to-sandbox`, false, `The sandbox is stopped.`],
            [`brought`, `to-sandbox`, false, `No machine agent runs on this computer.`],
        ]);
    });
});

// The window checks on its own (useBringBack.ts `useQuietChecks`): what it finds is drawn only when it is news, and the
// reader's own step is never taken from under them.
describe(`a check nobody pressed for`, () => {
    const at = (state: BringBackState, ...answers: ProjectAnswer[]): BringBackState => answers.reduce(answered, state);
    const quiet = (state: BringBackState): BringBackState => ({ ...state, quiet: true });
    const found = (changes: SandboxChange[]): ProjectAnswer => ({ kind: `changes`, result: { ok: true, direction: `to-sandbox`, changes } });
    const receipt: BringBackState = { ...IDLE, step: { at: `brought`, point: `rp-1`, count: 2, skipped: [] } };

    it(`fails without a word, leaving whatever was on screen`, () => {
        expect([
            at(quiet(IDLE), { kind: `changes`, result: { ok: false, error: `The sandbox is stopped.` } }),
            at(quiet(receipt), { kind: `error`, verb: `changes`, error: `No machine agent runs on this computer.` }),
        ]).toEqual([IDLE, receipt]);
    });

    it(`lists what it found, and learns the direction even when it found nothing`, () => {
        expect([at(quiet(IDLE), found(CHANGES)).step, at(quiet(IDLE), found([]))]).toEqual([
            { at: `checked`, changes: CHANGES, truncated: false },
            { ...IDLE, direction: `to-sandbox`, step: { at: `checked`, changes: [], truncated: false } },
        ]);
    });

    it(`keeps a receipt's Undo while nothing new has come, and gives way to changes that have`, () => {
        expect([at(quiet(receipt), found([])).step, at(quiet(receipt), found(CHANGES)).step.at]).toEqual([receipt.step, `checked`]);
    });

    it(`leaves a copy on its way alone`, () => {
        const bringing: BringBackState = { ...IDLE, step: { at: `bringing`, count: 2 } };
        expect(at(quiet(bringing), found(CHANGES)).step).toEqual(bringing.step);
    });
});

describe(`whether the section is drawn`, () => {
    const checked = (changes: SandboxChange[]): BringBackState => ({ ...IDLE, step: { at: `checked`, changes, truncated: false } });

    // "Bring back changes" over a folder with nothing to bring back read as a fault.
    it(`stays away until there is something to bring back, or something the reader set going`, () => {
        const states: BringBackState[] = [
            IDLE,
            { ...IDLE, quiet: true },
            checked([]),
            checked(CHANGES),
            { ...IDLE, step: { at: `checking` } },
            { ...IDLE, step: { at: `failed`, error: `Disk full.` } },
            { ...IDLE, step: { at: `restored`, count: 1 } },
        ];
        expect(states.map(sectionShown)).toEqual([false, false, false, true, true, true, true]);
    });

    // Both ways, nothing is ever left to bring back, and the way back to copy-first is in the section.
    it(`stays for a folder synced both ways, and while a switch of direction is on its way or has failed`, () => {
        const states: BringBackState[] = [
            { ...checked([]), direction: `both` },
            { ...IDLE, switching: true },
            { ...IDLE, switchError: `The sandbox is stopped.` },
        ];
        expect(states.map(sectionShown)).toEqual([true, true, true]);
    });
});

describe(`what a bring-back sends`, () => {
    // Never "everything": the app would take whatever the sandbox holds when the link lands, and an agent still at work
    // may have changed more since the review, deletions included.
    it(`names every chosen change, in the review's order, even when every one is chosen`, () => {
        expect([
            chosenPaths(CHANGES, new Set(CHANGES.map((change) => change.path))),
            chosenPaths(CHANGES, new Set([`old.txt`, `notes/plan.md`])),
            chosenPaths(CHANGES, new Set()),
        ]).toEqual([[`notes/plan.md`, `src/new.ts`, `old.txt`], [`notes/plan.md`, `old.txt`], []]);
    });

    it(`starts the review on every change but those changed on both sides, which a bring-back keeps as yours`, () => {
        const changes: SandboxChange[] = [...CHANGES, { path: `notes/draft.md`, kind: `modified`, conflict: true }];
        expect([...firstChosen(changes)]).toEqual([`notes/plan.md`, `src/new.ts`, `old.txt`]);
    });

    it(`reads a change made on both sides, and drops a field it has no use for`, () => {
        const answer = projectAnswer(
            event({
                kind: `changes`,
                result: { ok: true, direction: `to-sandbox`, changes: [{ path: `notes/draft.md`, kind: `modified`, conflict: true, hash: `abc` }] },
            }),
        );
        expect(answer).toEqual({
            kind: `changes`,
            result: { ok: true, direction: `to-sandbox`, changes: [{ path: `notes/draft.md`, kind: `modified`, conflict: true }] },
        });
    });
});
