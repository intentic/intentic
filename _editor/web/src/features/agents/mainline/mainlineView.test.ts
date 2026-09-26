import type { Finding, MainlineLand, MainlineLandRef, MainlineProject, MainlinePush, MainlineRoutingKind, MainlineRun, MainlineStatus, Red } from "@intentic/sandbox-contract";
import {
    checkSession,
    daemonOutdated,
    failuresOf,
    findingGist,
    fixTone,
    leftSince,
    mainlineSummary,
    pushDebtOf,
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

// A current daemon always sends `reds`; one from before 2026-09-25 sends none of the fields this readout is drawn from.
const status = (projects: MainlineProject[], recent: MainlineRun[] = []): MainlineStatus => ({ projects, recent, reds: [] });
const olderStatus = (projects: MainlineProject[], recent: MainlineRun[] = []): MainlineStatus => ({ projects, recent });

// A project red since its run `turned` it, laid where the daemon says.
const redProject = (turned: MainlineRun, cause: MainlineLandRef[] = []): MainlineProject =>
    project({ project: turned.project, last: turned, redSince: turned.at, red: { since: turned.at, cause, named: cause.length > 0 } });

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
                    { ...redProject(broken, [{ conversationId: `mine` }]), queued: [land(`c`, NOW - 1_000)] },
                ],
                [broken],
            ),
        );
        expect(summary).toEqual({
            running: { project: `web`, ...running },
            reds: [{ project: `api`, run: broken, since: broken.at, cause: [{ conversationId: `mine` }], named: true, fixer: undefined }],
            // One land queued in two projects is one land.
            queued: 1,
            checked: true,
            leftAtPush: 0,
            outdated: false,
        });
    });

    it(`says nothing about health while the first check of all is still running`, () => {
        const running = { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [] };
        expect(mainlineSummary(status([project({ running })]))).toEqual({
            running: { project: `web`, ...running },
            reds: [],
            queued: 0,
            checked: false,
            leftAtPush: 0,
            outdated: false,
        });
    });

    // Nothing is rebuilt from an older sandbox's runs: its red project is a red no one could lay, so the bar is told the
    // sandbox is out of date rather than drawing a guess at who has it, or "passing" for want of a red.
    it(`lays no red for a sandbox too old to serve one, and says it is out of date`, () => {
        const broken = red({ at: NOW - 9 * MINUTE, suspects: [`mine`] });
        const older = olderStatus([project({ last: broken, redSince: broken.at })], [broken]);
        expect(daemonOutdated(older)).toBe(true);
        expect(daemonOutdated(status([]))).toBe(false);
        expect(redsOf(older)).toEqual([]);
        expect(mainlineSummary(older)).toEqual({ running: undefined, reds: [], queued: 0, checked: true, leftAtPush: 0, outdated: true });
        expect(resultsOf(older)).toEqual([{ project: `web`, run: broken, red: undefined }]);
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
                    redProject(apiRed),
                    project({ project: `docs`, last: docs }),
                    project({ project: `never`, queued: [land(`q`, NOW)] }),
                    redProject(webRed),
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

    // An older sandbox's runs name suspects too, but only the daemon's own red says who a red is laid at.
    it(`is never rebuilt from the runs of a sandbox that serves no red`, () => {
        const turned = red({ at: NOW - 30 * MINUTE, lands: [land(`a`, NOW - 31 * MINUTE), land(`b`, NOW - 31 * MINUTE)], suspects: [`b`] });
        expect(redsOf(olderStatus([project({ last: turned, redSince: turned.at })], [turned]))).toEqual([]);
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

    // An older sandbox's failure lines are never split here: its reds are not drawn, so neither are they.
    it(`names nothing from a sandbox that sends no units`, () => {
        expect(failuresOf(red({ failures: [`web/src/pages/changelog.test.ts › lists every release`] }))).toEqual([]);
    });
});

describe(`checkSession`, () => {
    it(`is the terminal the daemon names for the project, and none where an older sandbox names none`, () => {
        expect(checkSession(status([project({ session: `panel-web--verify` })]), `web`)).toBe(`panel-web--verify`);
        expect(checkSession(olderStatus([project({ project: `a/b` })]), `a/b`)).toBeUndefined();
        expect(checkSession(status([]), ``)).toBeUndefined();
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
        // Only what a push left is dismissed, by the owner: settled, in its own words.
        expect(said(`dismissed`)).toEqual([`fixed`, `set aside`, `Set aside by you`, undefined, `text-success`]);
    });
});

// WHAT A PUSH LEFT BEHIND: the same projection, over the pushes the daemon files beside the lands' checks and the push
// reds that say what of it is still owed.
const finding = (id: string, over: Partial<Finding> = {}): Finding => ({ id, source: id, recheckable: true, text: `${id} says so`, ...over });

const push = (id: string, at: number, findings: Finding[], over: Partial<MainlinePush> = {}): MainlinePush => ({
    project: `intentic`,
    id,
    at,
    branch: `main`,
    head: `${id}0000000000`,
    commits: 1,
    findings,
    ...over,
});

const pushRed = (scope: string, findings: Finding[], over: Partial<Red> = {}): Red => ({
    source: `push`,
    scope,
    since: NOW - 30 * MINUTE,
    findings,
    suspects: [],
    named: false,
    decisions: [],
    ...over,
});

// Each project's push red as the daemon would file it from `pushes`: everything they found, oldest push first and each
// once, less what was since `settled` (resolved or dismissed).
const owing = (pushes: readonly MainlinePush[], settled: readonly string[] = []): Red[] => {
    const byProject = new Map<string, Finding[]>();
    for (const each of pushes.toReversed()) {
        const owed = byProject.get(each.project) ?? [];
        byProject.set(each.project, owed);
        owed.push(...each.findings.filter((found) => !settled.includes(found.id) && !owed.some((known) => known.id === found.id)));
    }
    return [...byProject].filter(([, owed]) => owed.length > 0).map(([scope, owed]) => pushRed(scope, owed));
};

// A status for what pushes left: the pushes, what is owed of them, the lands' record, and one project checked at `lastAt`
// when given. `pushes` undefined is a sandbox from before 2026-09-25, which sends neither.
const pushStatus = (
    pushes: MainlinePush[] | undefined,
    { settled = [], recent = [], lastAt, reds }: { settled?: string[]; recent?: MainlineRun[]; lastAt?: number; reds?: Red[] } = {},
): MainlineStatus => ({
    projects: lastAt === undefined ? [] : [{ project: `web`, queued: [], last: run({ at: lastAt }) }],
    recent,
    ...(pushes === undefined ? {} : { pushed: pushes, reds: reds ?? owing(pushes, settled) }),
});

describe(`pushDebtOf`, () => {
    it(`reads nothing from a sandbox too old to record pushes, or pushes that left nothing owed`, () => {
        expect(pushDebtOf(undefined)).toEqual([]);
        expect(pushDebtOf(pushStatus(undefined))).toEqual([]);
        expect(pushDebtOf(pushStatus([push(`a`, NOW, []), push(`b`, NOW - MINUTE, [finding(`paths`)])], { settled: [`paths`] }))).toEqual([]);
    });

    it(`reads a land check's red as none of its business`, () => {
        const landRed: Red = { ...pushRed(`intentic`, [finding(`paths`)]), source: `land` };
        expect(pushDebtOf(pushStatus([push(`a`, NOW, [finding(`paths`)])], { reds: [landRed] }))).toEqual([]);
    });

    it(`puts the tree's own breakage first, then orders by what measured it, keeping the daemon's order within one check`, () => {
        const [debt] = pushDebtOf(
            pushStatus([
                push(`a`, NOW, [
                    finding(`paths-1`, { source: `paths`, gate: `tidy` }),
                    finding(`silent-2`, { source: `silent-catch`, gate: `tidy` }),
                    finding(`layout-1`, { source: `layout`, gate: `code` }),
                    finding(`lint-1`, { source: `lint` }),
                    finding(`silent-1`, { source: `silent-catch`, gate: `code` }),
                    finding(`daemon-1`, { source: `daemon-boundaries`, gate: `code` }),
                    finding(`layout-2`, { source: `layout`, gate: `code` }),
                ]),
            ]),
        );
        expect(debt!.open.map((each) => each.id)).toEqual([`daemon-1`, `layout-1`, `layout-2`, `silent-1`, `lint-1`, `paths-1`, `silent-2`]);
    });

    it(`is what the red owes, with the pushes that brought any of it in, newest first`, () => {
        const newer = push(`b`, NOW, [finding(`paths`, { text: `newer words` }), finding(`gone`)]);
        const clean = push(`c`, NOW - MINUTE, []);
        const older = push(`a`, NOW - 2 * MINUTE, [finding(`layout`)]);
        const owed = pushRed(`intentic`, [finding(`layout`), finding(`paths`, { text: `newer words` })]);
        expect(pushDebtOf(pushStatus([newer, clean, older], { reds: [owed] }))).toEqual([
            { project: `intentic`, red: owed, open: [finding(`layout`), finding(`paths`, { text: `newer words` })], pushes: [newer, older], newest: newer },
        ]);
    });

    it(`still says what is owed when every push that brought it has aged out of the record`, () => {
        const owed = pushRed(`intentic`, [finding(`paths`)]);
        expect(pushDebtOf(pushStatus([], { reds: [owed] }))).toEqual([{ project: `intentic`, red: owed, open: [finding(`paths`)], pushes: [], newest: undefined }]);
    });

    it(`orders projects by how much each left, most first, and a tie in the order the daemon lists the reds`, () => {
        const debts = pushDebtOf(
            pushStatus([
                push(`w`, NOW, [finding(`paths`)], { project: `web` }),
                push(`i`, NOW - MINUTE, [finding(`paths`), finding(`layout`)]),
                push(`r`, NOW - 2 * MINUTE, [finding(`lint`)], { project: `` }),
            ]),
        );
        expect(debts.map((debt) => [debt.project, debt.open.length])).toEqual([
            [`intentic`, 2],
            [``, 1],
            [`web`, 1],
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

describe(`mainlineSummary with pushes`, () => {
    it(`counts everything the push reds owe across projects, each once`, () => {
        const summary = mainlineSummary(
            pushStatus(
                [
                    push(`b`, NOW, [finding(`paths`), finding(`layout`)]),
                    push(`a`, NOW - MINUTE, [finding(`paths`), finding(`lint`)]),
                    push(`w`, NOW - 2 * MINUTE, [finding(`paths`)], { project: `web` }),
                ],
                { settled: [`layout`], lastAt: NOW - 5 * MINUTE },
            ),
        );
        expect(summary).toEqual({ running: undefined, reds: [], queued: 0, checked: true, leftAtPush: 3, outdated: false });
    });

    it(`keeps main passing on the bar when what pushes left is the only other news`, () => {
        expect(mainlineSummary(pushStatus([push(`a`, NOW, [finding(`paths`)])], { lastAt: NOW - MINUTE }))).toEqual({
            running: undefined,
            reds: [],
            queued: 0,
            checked: true,
            leftAtPush: 1,
            outdated: false,
        });
        expect(mainlineSummary(pushStatus([], { lastAt: NOW - MINUTE }))).toEqual({
            running: undefined,
            reds: [],
            queued: 0,
            checked: true,
            leftAtPush: 0,
            outdated: false,
        });
    });

    it(`stands for a sandbox that pushed with findings but never landed, and not for one whose pushes left nothing`, () => {
        expect(mainlineSummary(pushStatus([push(`a`, NOW, [finding(`paths`)])]))).toEqual({
            running: undefined,
            reds: [],
            queued: 0,
            checked: false,
            leftAtPush: 1,
            outdated: false,
        });
        expect(mainlineSummary(pushStatus([push(`a`, NOW, [])]))).toBeUndefined();
        expect(mainlineSummary(pushStatus(undefined))).toBeUndefined();
    });

    // v1.312 files pushes without the reds that say what of them is owed: the bar stands to say it needs an update, and
    // counts nothing it cannot know.
    it(`stands for an older sandbox that pushed, counting nothing it cannot say is owed`, () => {
        const older: MainlineStatus = { projects: [], recent: [], pushed: [push(`a`, NOW, [finding(`paths`)])] };
        expect(mainlineSummary(older)).toEqual({ running: undefined, reds: [], queued: 0, checked: false, leftAtPush: 0, outdated: true });
    });
});

describe(`timelineOf`, () => {
    it(`merges lands' checks and pushes newest first, and cuts at the limit`, () => {
        const landNew = run({ at: NOW - MINUTE });
        const landOld = run({ at: NOW - 10 * MINUTE, status: `red` });
        const left = push(`left`, NOW - 2 * MINUTE, [finding(`paths`), finding(`lint`)]);
        const handled = push(`handled`, NOW - 5 * MINUTE, [finding(`layout`)]);
        const clean = push(`clean`, NOW - 20 * MINUTE, []);
        const merged = pushStatus([left, handled, clean], { settled: [`lint`, `layout`], recent: [landNew, landOld] });

        expect(timelineOf(merged, 8)).toEqual([
            { kind: `land`, run: landNew },
            { kind: `push`, push: left, open: 1, handled: false },
            { kind: `push`, push: handled, open: 0, handled: true },
            { kind: `land`, run: landOld },
            { kind: `push`, push: clean, open: 0, handled: false },
        ]);
        expect(timelineOf(merged, 2).map((event) => (event.kind === `land` ? event.run.at : event.push.id))).toEqual([NOW - MINUTE, `left`]);
    });

    it(`is the lands' record alone for a sandbox too old to say what its pushes left, even one that sent them`, () => {
        const checked = run();
        expect(timelineOf(pushStatus(undefined, { recent: [checked] }), 8)).toEqual([{ kind: `land`, run: checked }]);
        const older: MainlineStatus = { projects: [], recent: [checked], pushed: [push(`a`, NOW, [finding(`paths`)])] };
        expect(timelineOf(older, 8)).toEqual([{ kind: `land`, run: checked }]);
    });
});

describe(`leftSince`, () => {
    it(`counts what the pushes measured from the moment on left owed, and nothing from before it`, () => {
        const pushed = pushStatus(
            [
                push(`b`, NOW, [finding(`paths`), finding(`lint`)]),
                push(`w`, NOW - 1, [finding(`layout`), finding(`buttons`)], { project: `web` }),
                push(`a`, NOW - MINUTE, [finding(`silent-catch`)]),
            ],
            { settled: [`lint`] },
        );
        expect([leftSince(pushed, NOW - 1), leftSince(pushed, NOW), leftSince(pushed, NOW + 1), leftSince(undefined, 0)]).toEqual([3, 1, 0, 0]);
    });
});
