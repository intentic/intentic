import type { MainlineLand, MainlineProject, MainlineRoutingKind, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { causeOf, failureParts, fixTone, mainlineSummary, redsOf, resultsOf, routingMeta } from "./mainlineView";

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
            reds: [{ project: `api`, run: broken, since: broken.at, routing: undefined }],
            // One land queued in two projects is one land.
            queued: 1,
            checked: true,
        });
    });

    it(`says nothing about health while the first check of all is still running`, () => {
        const running = { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [] };
        expect(mainlineSummary(status([project({ running })]))).toEqual({ running: { project: `web`, ...running }, reds: [], queued: 0, checked: false });
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

describe(`causeOf`, () => {
    const streakOf = (runs: MainlineRun[]): MainlineStatus => {
        const [newest] = runs;
        const since = Math.min(...runs.map((each) => each.at));
        return status([project({ last: newest, redSince: since })], runs);
    };
    const causeIn = (runs: MainlineRun[]): string[] => {
        const line = streakOf(runs);
        const [first] = redsOf(line);
        return first === undefined ? [] : causeOf(line, first).map((each) => each.conversationId);
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
        const line = status([project({ last: turned, redSince: turned.at })], [turned, run({ at: NOW - 60 * MINUTE }), earlier]);
        const [first] = redsOf(line);
        expect(first === undefined ? [] : causeOf(line, first).map((each) => each.conversationId)).toEqual([`a`]);
    });
});

describe(`failureParts`, () => {
    it(`reads a failing test by its name first and the file it is in after`, () => {
        expect(failureParts(`@intentic/web#test _editor/web/src/features/chat/tabs/chatTabsLanes.test.ts › caps the Finished lane`)).toEqual({
            name: `caps the Finished lane`,
            file: `chatTabsLanes.test.ts`,
        });
        expect(failureParts(`web/src/pages/changelog.test.ts › lists every release › under its heading`)).toEqual({
            name: `lists every release › under its heading`,
            file: `changelog.test.ts`,
        });
        expect(failureParts(`app#test a.test.ts › x`)).toEqual({ name: `x`, file: `a.test.ts` });
    });

    it(`keeps anything that is not a test whole`, () => {
        const typeError = `web typecheck: src/pages/changelog.ts(41,7): Property 'tag' does not exist on type 'Release'`;
        expect(failureParts(typeError)).toEqual({ name: typeError });
        expect(failureParts(`w#test a › `)).toEqual({ name: `w#test a › ` });
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
