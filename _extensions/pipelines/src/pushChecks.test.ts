import { fixAttemptId, type PushCheck, type PushChecks, pushFixBase } from "@intentic/sandbox-contract";
import { findingGist, owedFindings, pushDebtOf, pushFixAttemptOf, pushProjectOf, pushRecordOf, pushTitle } from "./pushChecks";
import { agentCard, finding, owing, pushCheck, pushRed } from "./testing";

// No mocks: what a push left is a pure projection over the record the daemon serves (workspace.pushChecks), read the
// same way by the section, the rail's count and the hand-over.

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

// The record as the daemon serves it: the pushes, and what of them is owed, derived from them unless a suite says.
const record = (pushed: PushCheck[], { settled = [], reds }: { settled?: string[]; reds?: PushChecks["reds"] } = {}): PushChecks => ({
    pushed,
    reds: reds ?? owing(pushed, settled),
});

describe(`pushDebtOf`, () => {
    it(`reads nothing before the record answers, or from pushes that left nothing owed`, () => {
        expect(pushDebtOf(undefined)).toEqual([]);
        expect(pushDebtOf(record([]))).toEqual([]);
        expect(pushDebtOf(record([pushCheck(`a`, NOW, []), pushCheck(`b`, NOW - MINUTE, [finding(`paths`)])], { settled: [`paths`] }))).toEqual([]);
    });

    it(`reads main's CI red as none of its business`, () => {
        const ciRed = pushRed(`web/main`, [finding(`unit`)], { source: `ci` });
        expect(pushDebtOf(record([pushCheck(`a`, NOW, [finding(`unit`)])], { reds: [ciRed] }))).toEqual([]);
    });

    it(`puts the tree's own breakage first, then orders by what measured it, keeping the daemon's order within one check`, () => {
        const [debt] = pushDebtOf(
            record([
                pushCheck(`a`, NOW, [
                    finding(`paths-1`, { source: `paths`, gate: `tidy` }),
                    finding(`silent-2`, { source: `silent-catch`, gate: `tidy` }),
                    finding(`layout-1`, { source: `layout`, gate: `code` }),
                    finding(`lint-1`, { source: `lint` }),
                    finding(`silent-1`, { source: `silent-catch`, gate: `code` }),
                    finding(`cycle-1`, { source: `import-cycle`, gate: `code` }),
                    finding(`layout-2`, { source: `layout`, gate: `code` }),
                ]),
            ]),
        );
        expect(debt?.open.map((each) => each.id)).toEqual([`cycle-1`, `layout-1`, `layout-2`, `silent-1`, `lint-1`, `paths-1`, `silent-2`]);
    });

    it(`is what the red owes, with the pushes that brought any of it in, newest first`, () => {
        const newer = pushCheck(`b`, NOW, [finding(`paths`, { text: `newer words` }), finding(`gone`)]);
        const clean = pushCheck(`c`, NOW - MINUTE, []);
        const older = pushCheck(`a`, NOW - 2 * MINUTE, [finding(`layout`)]);
        const owed = pushRed(`web`, [finding(`layout`), finding(`paths`, { text: `newer words` })]);
        expect(pushDebtOf(record([newer, clean, older], { reds: [owed] }))).toEqual([
            {
                project: `web`,
                red: owed,
                open: [finding(`layout`), finding(`paths`, { text: `newer words` })],
                pushes: [newer, older],
                newest: newer,
            },
        ]);
    });

    it(`still says what is owed when every push that brought it has aged out of the record`, () => {
        const owed = pushRed(`web`, [finding(`paths`)]);
        expect(pushDebtOf(record([], { reds: [owed] }))).toEqual([
            { project: `web`, red: owed, open: [finding(`paths`)], pushes: [], newest: undefined },
        ]);
    });

    it(`orders projects by how much each left, most first, and a tie in the order the daemon lists the reds`, () => {
        const debts = pushDebtOf(
            record([
                pushCheck(`w`, NOW, [finding(`paths`)], { project: `api` }),
                pushCheck(`i`, NOW - MINUTE, [finding(`paths`), finding(`layout`)]),
                pushCheck(`r`, NOW - 2 * MINUTE, [finding(`lint`)], { project: `` }),
            ]),
        );
        expect(debts.map((debt) => [debt.project, debt.open.length])).toEqual([
            [`web`, 2],
            [``, 1],
            [`api`, 1],
        ]);
    });
});

describe(`owedFindings`, () => {
    it(`counts everything the push reds owe across projects, each once`, () => {
        const debts = pushDebtOf(
            record(
                [
                    pushCheck(`b`, NOW, [finding(`paths`), finding(`layout`)]),
                    pushCheck(`a`, NOW - MINUTE, [finding(`paths`), finding(`lint`)]),
                    pushCheck(`w`, NOW - 2 * MINUTE, [finding(`paths`)], { project: `api` }),
                ],
                { settled: [`layout`] },
            ),
        );
        expect(owedFindings(debts)).toBe(3);
        expect(owedFindings([])).toBe(0);
    });
});

// THE PUSH RECORD, the section's receipts: each push by what it left, newest first as the daemon lists them.
describe(`pushRecordOf`, () => {
    it(`reads each push by what it left: still owed, all of it since settled, or clean`, () => {
        const left = pushCheck(`left`, NOW - 2 * MINUTE, [finding(`paths`), finding(`lint`)]);
        const handled = pushCheck(`handled`, NOW - 5 * MINUTE, [finding(`layout`)]);
        const clean = pushCheck(`clean`, NOW - 20 * MINUTE, []);
        expect(pushRecordOf(record([left, handled, clean], { settled: [`lint`, `layout`] }))).toEqual([
            { push: left, open: 1, handled: false, refused: false },
            { push: handled, open: 0, handled: true, refused: false },
            { push: clean, open: 0, handled: false, refused: false },
        ]);
    });

    // Nothing reached the remote, and what the repository's own hook said is owed like any other finding.
    it(`says a push the repository's own hook refused was refused, and counts its one finding as owed`, () => {
        const refused = pushCheck(`refused`, NOW, [finding(`hook`, { recheckable: false })], { refused: true });
        expect(pushRecordOf(record([refused]))).toEqual([{ push: refused, open: 1, handled: false, refused: true }]);
    });

    it(`is nothing before the record answers`, () => {
        expect(pushRecordOf(undefined)).toEqual([]);
    });
});

describe(`findingGist`, () => {
    it(`keeps the file a finding names, or a folder with its parent, and the rest of the line as printed`, () => {
        expect(
            [
                `_sandbox/sandbox/src/workspace/files/workspace-trash.integration.test.ts:8  spells the state dir`,
                `_editor/web/src/features/workspace/explorer: 36 files, the baseline allows 33`,
                `_sandbox/sandbox/src/workspace/files: 32 files`,
                `web/a.ts`,
                `portability -> settings closes a cycle: imported at portability/definition.ts:18`,
                `lockfile: pnpm-lock.yaml is behind package.json`,
                `- _sandbox/sandbox/src/workspace/files/workspace-trash.ts:127  .catch discards the error`,
                `- portability -> settings closes a cycle`,
                ``,
            ].map(findingGist),
        ).toEqual([
            `workspace-trash.integration.test.ts:8  spells the state dir`,
            `workspace/explorer: 36 files, the baseline allows 33`,
            `workspace/files: 32 files`,
            `a.ts`,
            `portability -> settings closes a cycle: imported at portability/definition.ts:18`,
            `lockfile: pnpm-lock.yaml is behind package.json`,
            `workspace-trash.ts:127  .catch discards the error`,
            `portability -> settings closes a cycle`,
            ``,
        ]);
    });
});

describe(`pushTitle`, () => {
    it(`names a push by its commit, as git abbreviates it, and the branch it went to when one is named`, () => {
        expect(pushTitle(pushCheck(`725e054fb6`, NOW, []))).toBe(`725e054 → main`);
        const { branch: _main, ...nowhere } = pushCheck(`725e054fb6`, NOW, []);
        expect(pushTitle(nowhere)).toBe(`725e054`);
    });
});

describe(`pushProjectOf`, () => {
    // CI calls the workspace repository `root`; a push files it under its folder, which is empty.
    it(`reads CI's name for the workspace repository as the empty folder a push files it under`, () => {
        expect(pushProjectOf(`root`)).toBe(``);
        expect(pushProjectOf(`web`)).toBe(`web`);
        expect(pushProjectOf(`apps/web`)).toBe(`apps/web`);
    });
});

describe(`pushFixAttemptOf`, () => {
    const red = pushRed(`web`, [finding(`paths`)], { since: NOW - 30 * MINUTE });
    const base = pushFixBase(red) ?? ``;

    it(`is nobody until an agent was handed the red`, () => {
        expect(pushFixAttemptOf(red, [agentCard(`swift-otter-k9m2`)])).toBeUndefined();
        expect(pushFixAttemptOf(red, [])).toBeUndefined();
    });

    it(`is the newest attempt at the red, in the fleet's own words`, () => {
        const first = agentCard(base, { status: `stopped` });
        const second = agentCard(fixAttemptId(base, 2));
        const attempt = pushFixAttemptOf(red, [second, first]);
        expect(attempt).toMatchObject({ attempt: 2, agent: { id: fixAttemptId(base, 2) }, stance: { kind: `working`, ongoing: true, retry: false } });
    });

    it(`offers the press again for an attempt that ended, and says how it ended`, () => {
        const ended = pushFixAttemptOf(red, [agentCard(base, { status: `idle` })]);
        expect(ended?.stance).toMatchObject({ kind: `ended`, ongoing: false, retry: true, label: `Nothing changed` });
    });

    // A landed hand-over answered findings a later measurement will settle; a chip about work already in the tree says nothing.
    it(`is nobody once its attempt landed`, () => {
        expect(pushFixAttemptOf(red, [agentCard(base, { status: `landed` })])).toBeUndefined();
    });

    // The id is derived from when the red began, so a red that begins after everything was handled starts afresh.
    it(`does not carry an attempt at an earlier red over to a later one`, () => {
        const later = pushRed(`web`, [finding(`paths`)], { since: NOW });
        expect(pushFixAttemptOf(later, [agentCard(base)])).toBeUndefined();
    });
});
