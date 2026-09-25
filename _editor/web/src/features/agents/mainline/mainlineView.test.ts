import type {
    MainlineLand,
    MainlineProject,
    MainlinePush,
    MainlineRoutingKind,
    MainlineRun,
    MainlineStatus,
    PushFinding,
} from "@intentic/sandbox-contract";
import {
    checkSession,
    failuresOf,
    findingGist,
    fixTone,
    leftSince,
    mainlineSummary,
    pushDebtOf,
    recheckable,
    redsOf,
    resultsOf,
    routingMeta,
    timelineOf,
} from "./mainlineView";

// No mocks: the main line's readout is a pure projection over the status the daemon serves, like landCheck beside it.
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const land = (conversationId: string, at: number): MainlineLand => ({ conversationId, title: `work of ${conversationId}`, at });

const run = (over: Partial<MainlineRun> = {}): MainlineRun => ({
    project: `web`,
    command: `pnpm verify`,
    status: `green`,
    startedAt: NOW - 3 * MINUTE,
    at: NOW - 2 * MINUTE,
    lands: [land(`mine`, NOW - 4 * MINUTE)],
    failures: [],
    failureCount: 0,
    attempt: 0,
    ...over,
});

const red = (over: Partial<MainlineRun> = {}): MainlineRun => run({ status: `red`, failures: [`web/a.test.ts › renders`], failureCount: 1, attempt: 1, ...over });

const project = (over: Partial<MainlineProject> = {}): MainlineProject => ({ project: `web`, queued: [], ...over });

const status = (projects: MainlineProject[], recent: MainlineRun[] = []): MainlineStatus => ({ projects, recent });

describe(`mainlineSummary`, () => {
    it(`is nothing until something was checked, is running, or waits`, () => {
        expect(mainlineSummary(undefined)).toBeUndefined();
        expect(mainlineSummary(status([]))).toBeUndefined();
        expect(mainlineSummary(status([project()]))).toBeUndefined();
    });

    it(`keeps health and activity apart: the reds, whether anything was checked, what runs, how many wait`, () => {
        const running = { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [land(`b`, NOW - 6_000)] };
        const broken = red({ project: `api`, at: NOW - 9 * MINUTE });
        const summary = mainlineSummary(
            status(
                [
                    project({ running, queued: [land(`c`, NOW - 1_000)], last: run() }),
                    project({ project: `api`, queued: [land(`c`, NOW - 1_000)], last: broken, redSince: broken.at }),
                ],
                [broken],
            ),
        );
        expect(summary).toEqual({
            running: { project: `web`, ...running },
            // An older daemon's red, laid by the fallback: the one land of the run that turned it red.
            reds: [{ project: `api`, run: broken, since: broken.at, cause: [land(`mine`, NOW - 4 * MINUTE)], named: false, fixer: undefined }],
            // One land queued in two projects is one land.
            queued: 1,
            checked: true,
            leftAtPush: 0,
        });
    });

    it(`says nothing about health while the first check of all is still running`, () => {
        const running = { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [] };
        expect(mainlineSummary(status([project({ running })]))).toEqual({ running: { project: `web`, ...running }, reds: [], queued: 0, checked: false, leftAtPush: 0 });
    });
});

describe(`resultsOf`, () => {
    it(`stands every checked project in a line, the reds first and longest first, then the rest in folder order`, () => {
        const apiRed = red({ project: `api`, at: NOW - 5 * MINUTE });
        const webRed = red({ project: `web`, at: NOW - 30 * MINUTE });
        const docs = run({ project: `docs` });
        const results = resultsOf(
            status(
                [
                    project({ project: `api`, last: apiRed, redSince: apiRed.at }),
                    project({ project: `docs`, last: docs }),
                    project({ project: `never`, queued: [land(`q`, NOW)] }),
                    project({ project: `web`, last: webRed, redSince: webRed.at }),
                ],
                [apiRed, webRed, docs],
            ),
        );
        expect(results.map((result) => [result.project, result.red === undefined ? `line` : `red`])).toEqual([
            [`web`, `red`],
            [`api`, `red`],
            [`docs`, `line`],
        ]);
        expect(results.map((result) => result.run)).toEqual([webRed, apiRed, docs]);
    });
});

describe(`a red's cause`, () => {
    // What the daemon laid it at is the answer: nothing on this side re-reads the runs.
    it(`is the red the daemon serves, cause, narrowing and fixer as it says`, () => {
        const turned = red({ at: NOW - 30 * MINUTE, lands: [land(`a`, NOW - 31 * MINUTE), land(`b`, NOW - 31 * MINUTE)], suspects: [`b`], named: true });
        const fixer = { kind: `fix-up` as const, conversationId: `land-fix-web-1`, at: NOW - 20 * MINUTE };
        const served = { since: turned.at, cause: [{ conversationId: `b`, title: `work of b` }], named: true, fixer };
        const [first] = redsOf(status([project({ last: turned, redSince: turned.at, red: served })], [turned]));
        expect(first).toEqual({ project: `web`, run: turned, since: turned.at, cause: served.cause, named: true, fixer });
    });

    it(`is nobody when the daemon laid it at nobody, whatever lands the run covered`, () => {
        const found = red({ lands: [land(`c`, NOW - 6 * MINUTE)], named: false });
        const [first] = redsOf(status([project({ last: found, redSince: found.at, red: { since: found.at, cause: [], named: false } })], [found]));
        expect(first?.cause).toEqual([]);
    });

    // FALLBACK: a daemon that serves no `red` still gets a cause, rebuilt from its runs the way it used to be.
    describe(`from a daemon that serves none`, () => {
        const causeIn = (runs: MainlineRun[]): string[] => {
            const [newest] = runs;
            const since = Math.min(...runs.map((each) => each.at));
            const [first] = redsOf(status([project({ last: newest, redSince: since })], runs));
            return first === undefined ? [] : first.cause.map((each) => each.conversationId);
        };

        it(`is the suspects the sandbox named, on whichever run of the streak named them`, () => {
            const turned = red({ at: NOW - 30 * MINUTE, lands: [land(`a`, NOW - 31 * MINUTE), land(`b`, NOW - 31 * MINUTE)], suspects: [`b`] });
            const later = red({ at: NOW - 5 * MINUTE, lands: [land(`c`, NOW - 6 * MINUTE)], attempt: 2 });
            expect(causeIn([later, turned])).toEqual([`b`]);
        });

        it(`is every land of the run that turned the project red, where nobody was named`, () => {
            const turned = red({ at: NOW - 30 * MINUTE, lands: [land(`a`, NOW - 31 * MINUTE), land(`b`, NOW - 31 * MINUTE)] });
            const later = red({ at: NOW - 5 * MINUTE, lands: [land(`c`, NOW - 6 * MINUTE)], attempt: 2 });
            expect(causeIn([later, turned])).toEqual([`a`, `b`]);
        });

        // A later run only found main red; offering its land as the cause would blame the work that walked into it.
        it(`is nobody when the record no longer reaches the run that turned it red`, () => {
            expect(causeIn([red({ at: NOW - 5 * MINUTE, lands: [land(`c`, NOW - 6 * MINUTE)], attempt: 3 })])).toEqual([]);
        });

        it(`never reaches back past the streak into an earlier red of the same project`, () => {
            const earlier = red({ at: NOW - 90 * MINUTE, lands: [land(`old`, NOW - 91 * MINUTE)], suspects: [`old`] });
            const turned = red({ at: NOW - 30 * MINUTE, lands: [land(`a`, NOW - 31 * MINUTE)] });
            const [first] = redsOf(status([project({ last: turned, redSince: turned.at })], [turned, run({ at: NOW - 60 * MINUTE }), earlier]));
            expect(first?.cause.map((each) => each.conversationId)).toEqual([`a`]);
        });
    });
});

describe(`failuresOf`, () => {
    it(`reads a failure the daemon split by its name, with the file of its path after unless the name already says it`, () => {
        const typeError = `web typecheck: src/pages/changelog.ts(41,7): Property 'tag' does not exist on type 'Release'`;
        const split = red({
            units: [
                { name: `caps the Finished lane`, path: `_editor/web/src/features/chat/tabs/chatTabsLanes.test.ts` },
                { name: typeError, path: `src/pages/changelog.ts(41,7)` },
                { name: `@intentic/web#test` },
            ],
        });
        expect(failuresOf(split)).toEqual([{ name: `caps the Finished lane`, file: `chatTabsLanes.test.ts` }, { name: typeError }, { name: `@intentic/web#test` }]);
    });

    // FALLBACK: a daemon that sends no `units` gets its failure lines split here, the way they used to be.
    it(`splits a failing test's line by its name first and the file it is in after, from a daemon that sends no units`, () => {
        const lines = red({
            failures: [
                `@intentic/web#test _editor/web/src/features/chat/tabs/chatTabsLanes.test.ts › caps the Finished lane`,
                `web/src/pages/changelog.test.ts › lists every release › under its heading`,
                `w#test a › `,
            ],
        });
        expect(failuresOf(lines)).toEqual([
            { name: `caps the Finished lane`, file: `chatTabsLanes.test.ts` },
            { name: `lists every release › under its heading`, file: `changelog.test.ts` },
            { name: `w#test a › ` },
        ]);
    });
});

describe(`checkSession`, () => {
    it(`is the terminal the daemon names for the project, or the one an older daemon's panel runs in`, () => {
        expect(checkSession(status([project({ session: `panel-web--verify` })]), `web`)).toBe(`panel-web--verify`);
        expect(checkSession(status([project({ project: `a/b` })]), `a/b`)).toBe(`panel-a_b--verify`);
        expect(checkSession(status([]), ``)).toBe(`panel-root--verify`);
    });
});

describe(`routingMeta`, () => {
    const said = (kind: MainlineRoutingKind | undefined) => {
        const meta = routingMeta(kind);
        return [meta.state, meta.short, meta.words, meta.lead, fixTone(meta.state)];
    };

    // Seven decisions, told apart by the daemon, read as the three a reader acts on.
    it(`says who has a red in the words a reader acts on`, () => {
        expect(said(`fix-up`)).toEqual([`fixing`, `fixing`, `Being fixed`, `Being fixed in`, `text-muted`]);
        expect(said(`original`)).toEqual([`fixing`, `fixing`, `Being fixed`, `Being fixed in`, `text-muted`]);
        expect(said(`held`)).toEqual([`on-hold`, `on hold`, `Waiting for another chat to finish`, `Waiting for`, `text-muted`]);
        expect(said(`waiting`)).toEqual([`on-hold`, `on hold`, `Waiting for the next check`, undefined, `text-muted`]);
        expect(said(undefined)).toEqual([`on-hold`, undefined, `Deciding who fixes it`, undefined, `text-muted`]);
        expect(said(`reported`)).toEqual([`needs-you`, `needs you`, `Nobody is fixing it`, undefined, `text-warning`]);
        expect(said(`spent`)).toEqual([`needs-you`, `needs you`, `Out of fix attempts`, undefined, `text-warning`]);
        expect(said(`resolved`)).toEqual([`fixed`, `fixed`, `Fixed by the next check`, undefined, `text-success`]);
    });
});

// WHAT A PUSH LEFT BEHIND: the same projection, over the pushes the daemon files beside the lands' checks.
const finding = (id: string, over: Partial<PushFinding> = {}): PushFinding => ({ id, kind: `check`, check: id, text: `${id} says so`, state: `open`, ...over });

const push = (id: string, at: number, findings: PushFinding[], over: Partial<MainlinePush> = {}): MainlinePush => ({
    project: `intentic`,
    id,
    at,
    branch: `main`,
    head: `${id}0000000000`,
    commits: 1,
    findings,
    ...over,
});

// A status for what pushes left: the pushes, the lands' record, and one project checked at `lastAt` when given.
const pushStatus = (pushes: MainlinePush[] | undefined, recent: MainlineRun[] = [], lastAt?: number): MainlineStatus => ({
    projects: lastAt === undefined ? [] : [{ project: `web`, queued: [], last: run({ at: lastAt }) }],
    recent,
    ...(pushes === undefined ? {} : { pushes }),
});

describe(`pushDebtOf`, () => {
    it(`reads nothing from a daemon that records no pushes, or pushes that left nothing open`, () => {
        expect(pushDebtOf(undefined)).toEqual([]);
        expect(pushDebtOf(pushStatus(undefined))).toEqual([]);
        expect(pushDebtOf(pushStatus([push(`a`, NOW, []), push(`b`, NOW - MINUTE, [finding(`paths`, { state: `resolved`, settledAt: NOW })])]))).toEqual([]);
    });

    it(`puts the tree's own breakage first, then orders by what measured it, keeping the daemon's order within one check`, () => {
        const [debt] = pushDebtOf(
            pushStatus([
                push(`a`, NOW, [
                    finding(`paths-1`, { check: `paths`, gate: `tidy` }),
                    finding(`silent-2`, { check: `silent-catch`, gate: `tidy` }),
                    finding(`layout-1`, { check: `layout`, gate: `code` }),
                    finding(`lint-1`, { kind: `lint`, check: undefined }),
                    finding(`silent-1`, { check: `silent-catch`, gate: `code` }),
                    finding(`daemon-1`, { check: `daemon-boundaries`, gate: `code` }),
                    finding(`layout-2`, { check: `layout`, gate: `code` }),
                ]),
            ]),
        );
        expect(debt!.open.map((each) => each.id)).toEqual([`daemon-1`, `layout-1`, `layout-2`, `silent-1`, `lint-1`, `paths-1`, `silent-2`]);
    });

    it(`counts a problem two pushes found once, as the newer push printed it, and keeps only the pushes still holding one`, () => {
        const newer = push(`b`, NOW, [finding(`paths`, { text: `newer words` }), finding(`gone`, { state: `dismissed`, settledAt: NOW })]);
        const clean = push(`c`, NOW - MINUTE, []);
        const older = push(`a`, NOW - 2 * MINUTE, [finding(`paths`, { text: `older words` }), finding(`layout`)]);
        expect(pushDebtOf(pushStatus([newer, clean, older]))).toEqual([
            {
                project: `intentic`,
                open: [finding(`layout`), finding(`paths`, { text: `newer words` })],
                pushes: [newer, older],
                newest: newer,
            },
        ]);
    });

    it(`orders projects by how much each left, most first`, () => {
        const debts = pushDebtOf(
            pushStatus([
                push(`w`, NOW, [finding(`paths`)], { project: `web` }),
                push(`i`, NOW - MINUTE, [finding(`paths`), finding(`layout`)]),
                push(`r`, NOW - 2 * MINUTE, [finding(`lint`)], { project: `` }),
            ]),
        );
        expect(debts.map((debt) => [debt.project, debt.open.length])).toEqual([
            [`intentic`, 2],
            [`web`, 1],
            [``, 1],
        ]);
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

describe(`recheckable`, () => {
    it(`is a check's or the linter's finding, never one about the pushed commits themselves`, () => {
        expect(
            ([`check`, `lint`, `ratchet`, `lockstep`, `rustfmt`] as const).map((kind) => [kind, recheckable(finding(`x`, { kind }))]),
        ).toEqual([
            [`check`, true],
            [`lint`, true],
            [`ratchet`, false],
            [`lockstep`, false],
            [`rustfmt`, false],
        ]);
    });
});

describe(`mainlineSummary with pushes`, () => {
    it(`counts every open finding across projects, each once`, () => {
        const summary = mainlineSummary(
            pushStatus(
                [
                    push(`b`, NOW, [finding(`paths`), finding(`layout`, { state: `resolved`, settledAt: NOW })]),
                    push(`a`, NOW - MINUTE, [finding(`paths`), finding(`lint`)]),
                    push(`w`, NOW - 2 * MINUTE, [finding(`paths`)], { project: `web` }),
                ],
                [],
                NOW - 5 * MINUTE,
            ),
        );
        expect(summary).toEqual({ running: undefined, reds: [], queued: 0, checked: true, leftAtPush: 3 });
    });

    it(`keeps main passing on the bar when what pushes left is the only other news`, () => {
        expect(mainlineSummary(pushStatus([push(`a`, NOW, [finding(`paths`)])], [], NOW - MINUTE))).toEqual({
            running: undefined,
            reds: [],
            queued: 0,
            checked: true,
            leftAtPush: 1,
        });
        expect(mainlineSummary(pushStatus([], [], NOW - MINUTE))).toEqual({ running: undefined, reds: [], queued: 0, checked: true, leftAtPush: 0 });
    });

    it(`stands for a sandbox that pushed with findings but never landed, and not for one whose pushes left nothing`, () => {
        expect(mainlineSummary(pushStatus([push(`a`, NOW, [finding(`paths`)])]))).toEqual({
            running: undefined,
            reds: [],
            queued: 0,
            checked: false,
            leftAtPush: 1,
        });
        expect(mainlineSummary(pushStatus([push(`a`, NOW, [])]))).toBeUndefined();
        expect(mainlineSummary(pushStatus(undefined))).toBeUndefined();
    });
});

describe(`timelineOf`, () => {
    it(`merges lands' checks and pushes newest first, and cuts at the limit`, () => {
        const landNew = run({ at: NOW - MINUTE });
        const landOld = run({ at: NOW - 10 * MINUTE, status: `red` });
        const left = push(`left`, NOW - 2 * MINUTE, [finding(`paths`), finding(`lint`, { state: `dismissed`, settledAt: NOW })]);
        const handled = push(`handled`, NOW - 5 * MINUTE, [finding(`paths`, { state: `resolved`, settledAt: NOW })]);
        const clean = push(`clean`, NOW - 20 * MINUTE, []);
        const merged = pushStatus([left, handled, clean], [landNew, landOld]);

        expect(timelineOf(merged, 8)).toEqual([
            { kind: `land`, run: landNew },
            { kind: `push`, push: left, open: 1, handled: false },
            { kind: `push`, push: handled, open: 0, handled: true },
            { kind: `land`, run: landOld },
            { kind: `push`, push: clean, open: 0, handled: false },
        ]);
        expect(timelineOf(merged, 2).map((event) => (event.kind === `land` ? event.run.at : event.push.id))).toEqual([NOW - MINUTE, `left`]);
    });

    it(`is the lands' record alone for a daemon that records no pushes`, () => {
        const checked = run();
        expect(timelineOf(pushStatus(undefined, [checked]), 8)).toEqual([{ kind: `land`, run: checked }]);
    });
});

describe(`leftSince`, () => {
    it(`counts what the pushes measured from the moment on left open, and nothing from before it`, () => {
        const pushed = pushStatus([
            push(`b`, NOW, [finding(`paths`), finding(`lint`, { state: `dismissed`, settledAt: NOW })]),
            push(`w`, NOW - 1, [finding(`layout`), finding(`buttons`)], { project: `web` }),
            push(`a`, NOW - MINUTE, [finding(`silent-catch`)]),
        ]);
        expect([leftSince(pushed, NOW - 1), leftSince(pushed, NOW), leftSince(pushed, NOW + 1), leftSince(undefined, 0)]).toEqual([3, 1, 0, 0]);
    });
});
