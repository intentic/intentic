//
// Needs jsdom: this file's import chain reaches the app's theme, which touches the document as it loads.
import "@intentic/testing/dom";
import SandboxRecovery from "../../features/sandbox/gates/SandboxRecovery.vue";
import { RESTART_PATIENCE_MS, type RestartWork } from "../../features/sandbox/live/sandboxRestart";
import type { DiagnosisNotice } from "../../features/sandbox/diagnosis/presentation";
import { diagnosisCard, restartCard, type UploadState, uploadHeadline, uploadPhase } from "./notificationSources";

// The lane's one rule about a sandbox going quiet: whether the silence was asked for decides both what is said and
// how soon. Everything else in this file is wiring; this is the decision.

const rebuild: RestartWork = {
    sandbox: `sbx-1`,
    id: `dev-rebuild`,
    what: `Rebuilding from your checkout`,
    quiet: { title: `Restarting onto the image you built`, detail: `About half a minute, then this page reconnects on its own.` },
    startedAt: 0,
};

describe(`the card for a sandbox that has gone quiet`, () => {
    it(`speaks the moment a restart this browser asked for takes the sandbox away`, () => {
        // `stale` is the first half minute of an outage, which is deliberately invisible for silence nobody can
        // account for. This one is accounted for, and waiting to say so means saying it as the sandbox returns.
        const card = restartCard(rebuild, `stale`, 0);
        expect(card?.title).toBe(rebuild.quiet.title);
        expect(card?.detail).toBe(rebuild.quiet.detail);
    });

    it(`keeps saying it through every shape a swap takes from here`, () => {
        // `detached` is the edge's own verdict, and it arrives 20s into a 30s restart: the card used to disappear at
        // exactly the moment the wait started feeling long.
        for (const availability of [`stale`, `busy`, `detached`] as const) {
            expect(restartCard(rebuild, availability, 25_000)?.title).toBe(rebuild.quiet.title);
        }
    });

    it(`offers nothing to press, since the swap is already under way`, () => {
        expect(restartCard(rebuild, `busy`, 0)?.actions).toBeUndefined();
    });

    it(`stops promising half a minute once the restart has taken far longer than one`, () => {
        expect(restartCard(rebuild, `busy`, RESTART_PATIENCE_MS)).toBeUndefined();
    });

    it(`says nothing while the sandbox is answering, however much is being built`, () => {
        expect(restartCard(rebuild, `live`, 0)).toBeUndefined();
    });

    it(`claims nothing about a silence nobody here asked for`, () => {
        expect(restartCard(undefined, `stale`, 0)).toBeUndefined();
        expect(restartCard(undefined, `busy`, 45_000)).toBeUndefined();
    });
});

// The outage over a painted workspace, in the diagnosis's words: a calm wait while waiting is the answer, a warning with
// the recovery panel once the diagnosis found a way back, put away for this outage alone when dismissed.
describe(`the card for a sandbox that isn't answering`, () => {
    const notice = (over: Partial<DiagnosisNotice> = {}): DiagnosisNotice => ({
        title: `acme is busy`,
        body: `It's still running and will catch up by itself.`,
        waiting: true,
        tone: `info`,
        chain: [],
        action: undefined,
        otherActions: [],
        findings: [],
        ...over,
    });

    it(`is a calm wait with a spinner and no panel while nothing needs doing`, () => {
        const card = diagnosisCard(notice(), false, () => undefined);
        expect(card).toMatchObject({ kind: `condition`, tone: `info`, icon: `spinner`, spin: true, title: `acme is busy` });
        expect(card.detail).toBe(`It's still running and will catch up by itself.`);
        expect(card.body).toBeUndefined();
    });

    it(`carries the recovery panel once there is a way back, and can be put away`, () => {
        let dismissed = 0;
        const card = diagnosisCard(notice({ title: `acme isn't connected`, waiting: false, tone: `warning`, action: `fix` }), true, () => (dismissed += 1));
        expect(card).toMatchObject({ tone: `warning`, title: `acme isn't connected`, wide: true });
        expect(card.spin).toBeUndefined();
        expect(card.body).toBe(SandboxRecovery);
        card.dismiss?.();
        expect(dismissed).toBe(1);
    });

    it(`opens the panel for the other options a long wait earns, without turning the wait into a warning`, () => {
        const card = diagnosisCard(notice({ otherActions: [`fix`] }), false, () => undefined);
        expect(card).toMatchObject({ tone: `info`, spin: true, wide: true });
        expect(card.body).toBe(SandboxRecovery);
    });
});

describe(`the card for files dropped into the workspace`, () => {
    const idle: UploadState = {
        count: 0,
        done: 0,
        failed: 0,
        finished: false,
        scanning: false,
        scanned: 0,
        scannedBytes: 0,
        preparing: 0,
        startError: undefined,
        unreadable: 0,
        skipped: undefined,
        unchanged: 0,
    };

    it(`stays up from the first scanned file to the first queued one, naming each step between`, () => {
        // The step between, asking the sandbox what it already has, used to have no card at all: a big drop's import
        // vanished for as long as that took.
        const steps: UploadState[] = [
            { ...idle, scanning: true, scanned: 66_412, scannedBytes: 30 * 1024 ** 3 },
            { ...idle, scanned: 66_412, preparing: 66_412 },
            { ...idle, count: 66_412 },
        ];
        expect(steps.map(uploadPhase)).toEqual([`scanning`, `preparing`, `uploading`]);
        expect(uploadHeadline(`scanning`, steps[0] ?? idle).detail).toContain(`30 GB`);
    });

    it(`says why when the drop never reached the queue, rather than saying nothing`, () => {
        const state = { ...idle, scanned: 66_412, startError: `Maximum call stack size exceeded` };
        expect([uploadPhase(state), uploadHeadline(`notStarted`, state).tone, uploadHeadline(`notStarted`, state).detail]).toEqual([
            `notStarted`,
            `problem`,
            `Maximum call stack size exceeded`,
        ]);
    });

    it(`counts files the scan could not read as failed ones, so the finish does not claim everything landed`, () => {
        const state = { ...idle, count: 10, done: 10, finished: true, unreadable: 2 };
        expect(uploadPhase(state)).toBe(`partial`);
    });
});
