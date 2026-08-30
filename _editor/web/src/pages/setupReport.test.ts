import type { SetupReport } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { setupReportView } from "./setupReport";

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
        expect(view.stage).toContain(`pulling the sandbox image`);
        // The one honest multi-minute stage sets its own expectation, so the wait reads as normal, not stuck.
        expect(view.stage).toContain(`takes a few minutes`);
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
