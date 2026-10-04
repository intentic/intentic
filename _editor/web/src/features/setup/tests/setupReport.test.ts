import type { SetupReport } from "@intentic/api-contract";
import { setupFailedEvent, setupReportView } from "../setupReport";

const report = (overrides: Partial<SetupReport>): SetupReport => ({
    stage: `pulling-image`,
    failed: [],
    at: `2026-08-07T12:00:00.000Z`,
    ...overrides,
});

describe(`setupReportView`, () => {
    it(`is empty with no report: an old ic never reports, and the card keeps its canned lines`, () => {
        expect(setupReportView(null)).toEqual({ failures: null, stage: undefined });
    });

    it(`narrates a healthy run's stage in the user's words`, () => {
        const view = setupReportView(report({ stage: `pulling-image` }));
        expect(view.failures).toBeNull();
        expect(view.stage).toEqual(expect.stringMatching(/\S/));
        expect(view.stage).not.toBe(setupReportView(report({ stage: `done` })).stage);
    });

    it(`turns failures into a diagnosis and drops the narration: never both`, () => {
        const failed = [{ check: `Docker`, problem: `the docker daemon is not running.`, remedy: `start Docker, then re-run.` }];
        const view = setupReportView(report({ stage: `preflight`, failed }));
        expect(view.failures).toEqual(failed);
        expect(view.stage).toBeUndefined();
    });

    it(`covers every stage the wire allows: a new stage without words would render 'undefined'`, () => {
        const stages: SetupReport[`stage`][] = [
            `preflight`,
            `pulling-image`,
            `creating-tunnel`,
            `starting-sandbox`,
            `starting-connector`,
            `waiting-health`,
            `verifying`,
            `done`,
        ];
        for (const stage of stages) {
            expect(setupReportView(report({ stage })).stage, stage).toEqual(expect.stringMatching(/\S/));
        }
    });
});

describe(`setupFailedEvent`, () => {
    // The failure a stale ghcr.io login produced (2026-10-04): until the event carried it, the only trace was a replay
    // whose every word was starred.
    it(`carries the stage, every check, and the first problem in the machine's own words`, () => {
        const problem = `ghcr.io/intentic/sandbox:stable did not finish downloading in 3 attempts. Docker said: Error response from daemon: error from registry: denied`;
        const failed = [
            { check: `pulling-image`, problem, remedy: `` },
            { check: `Docker`, problem: `the docker daemon is not running.`, remedy: `` },
        ];
        expect(setupFailedEvent(report({ failed }))).toEqual({ stage: `pulling-image`, checks: `pulling-image,Docker`, problem });
    });

    it(`stars what in the problem could name the person or their machine`, () => {
        const path = `C:\\Users\\grace\\.docker\\config.json`;
        const email = `grace@example.com`;
        const failed = [{ check: `This PC`, problem: `could not read ${path} as ${email}`, remedy: `` }];
        expect(setupFailedEvent(report({ stage: `preflight`, failed })).problem).toBe(`could not read ${`*`.repeat(path.length)} as ${`*`.repeat(email.length)}`);
    });
});
