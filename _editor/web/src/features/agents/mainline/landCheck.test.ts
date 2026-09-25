import type { MainlineLand, MainlineProject, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { cardChecks, landCheck, proofMark } from "./landCheck";

// No mocks: landCheck is a pure projection over the status the daemon serves, like agentStatus beside it.
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

const red = (over: Partial<MainlineRun> = {}): MainlineRun =>
    run({ status: `red`, failures: [`web/a.test.ts › renders`, `web/b.test.ts › links`], failureCount: 2, attempt: 1, ...over });

const project = (over: Partial<MainlineProject> = {}): MainlineProject => ({ project: `web`, queued: [], ...over });

const status = (projects: MainlineProject[], recent: MainlineRun[] = []): MainlineStatus => ({ projects, recent });

describe(`landCheck`, () => {
    it(`says nothing without a status, or for a conversation the record never measured`, () => {
        expect(landCheck(`mine`, undefined)).toBeUndefined();
        expect(landCheck(`mine`, status([project()], [run({ lands: [land(`other`, NOW)] })]))).toBeUndefined();
    });

    it(`is checking while a running check answers for its land, from when that check started`, () => {
        const measured = status([project({ running: { command: `pnpm verify`, startedAt: NOW - 30_000, lands: [land(`mine`, NOW - MINUTE)] } })], [red()]);
        expect(landCheck(`mine`, measured)).toEqual({ kind: `checking`, project: `web`, since: NOW - 30_000 });
    });

    it(`is waiting while its land is queued, however an older land of it was answered`, () => {
        const queued = status([project({ queued: [land(`other`, NOW - 2 * MINUTE), land(`mine`, NOW - MINUTE)] })], [red()]);
        expect(landCheck(`mine`, queued)).toEqual({ kind: `waiting`, project: `web`, since: NOW - MINUTE });
    });

    it(`passed when the newest run that measured it was green`, () => {
        expect(landCheck(`mine`, status([project()], [run()]))).toEqual({ kind: `passed`, project: `web`, since: NOW - 2 * MINUTE });
    });

    // The newest land is the one a reader asks about: a fix that landed and passed clears the red its first land caused.
    it(`reads the newest run holding it, so a later green land outranks an earlier red one`, () => {
        const record = [run({ at: NOW - MINUTE, lands: [land(`mine`, NOW - 2 * MINUTE)] }), red({ at: NOW - 20 * MINUTE, suspects: [`mine`] })];
        expect(landCheck(`mine`, status([project()], record))?.kind).toBe(`passed`);
    });

    it(`broke main when the suspects name it, with the failures and who has them`, () => {
        const routed = red({
            lands: [land(`mine`, NOW - 5 * MINUTE), land(`other`, NOW - 4 * MINUTE)],
            suspects: [`mine`],
            routing: { kind: `fix-up`, conversationId: `land-fix-web-abc`, at: NOW - MINUTE },
        });
        expect(landCheck(`mine`, status([project()], [routed]))).toEqual({
            kind: `broke`,
            project: `web`,
            since: NOW - 2 * MINUTE,
            failures: 2,
            routing: `fix-up`,
            fixUp: `land-fix-web-abc`,
        });
        // The other land in the same run was not named, so the red is main's, not its.
        expect(landCheck(`other`, status([project()], [routed]))).toEqual({ kind: `checked-red`, project: `web`, since: NOW - 2 * MINUTE });
    });

    it(`does not call its own conversation a fix-up when the red was sent back to it`, () => {
        const sentBack = red({ suspects: [`mine`], routing: { kind: `original`, conversationId: `mine`, at: NOW - MINUTE } });
        const check = landCheck(`mine`, status([project()], [sentBack]));
        expect(check).toEqual({ kind: `broke`, project: `web`, since: NOW - 2 * MINUTE, failures: 2, routing: `original` });
        expect(check?.fixUp).toBeUndefined();
    });

    it(`blames the only land of a run that turned a green project red before anybody is named`, () => {
        expect(landCheck(`mine`, status([project()], [red()]))?.kind).toBe(`broke`);
    });

    // A red streak's later run names nobody when nothing new failed in it: its one land found main red, it did not
    // turn it, and a card must not wear somebody else's breakage.
    it(`does not blame the one land of a run that only extends a red streak`, () => {
        expect(landCheck(`mine`, status([project()], [red({ attempt: 3 })]))).toEqual({ kind: `checked-red`, project: `web`, since: NOW - 2 * MINUTE });
    });

    it(`does not blame a land the suspects leave out, even when it was the run's only one`, () => {
        expect(landCheck(`mine`, status([project()], [red({ suspects: [`earlier`] })]))?.kind).toBe(`checked-red`);
    });

    // One land touching two projects is checked in each; the worse answer is what it did.
    it(`answers a land checked in two projects with the worse of the two`, () => {
        const both = land(`mine`, NOW - 6 * MINUTE);
        const record = [run({ project: `api`, at: NOW - MINUTE, lands: [both] }), red({ at: NOW - 3 * MINUTE, lands: [both] })];
        expect(landCheck(`mine`, status([project(), project({ project: `api` })], record))).toMatchObject({ kind: `broke`, project: `web` });
    });
});

describe(`proofMark`, () => {
    it(`marks what the last turn showed, and nothing for a turn that changed no code and looked at everything`, () => {
        expect(proofMark(undefined)).toBeUndefined();
        expect(proofMark({ at: NOW, verification: `no-code` })).toBeUndefined();
        expect(proofMark({ at: NOW, verification: `no-code`, unviewed: 0 })).toBeUndefined();
        expect(proofMark({ at: NOW, verification: `unproven` })).toEqual({ verification: `unproven` });
        expect(proofMark({ at: NOW, verification: `failing`, check: `pnpm test src/a.test.ts` })).toEqual({ verification: `failing`, check: `pnpm test src/a.test.ts` });
        expect(proofMark({ at: NOW, verification: `no-code`, unviewed: 3 })).toEqual({ unviewed: 3 });
    });
});

describe(`cardChecks`, () => {
    const measured = status([project()], [red()]);

    it(`reads main's check only for this sandbox's own agents`, () => {
        expect(cardChecks({ id: `mine` }, measured, false)?.land?.kind).toBe(`broke`);
        expect(cardChecks({ id: `mine`, sandboxId: `sbx-2` }, measured, false)).toBeUndefined();
    });

    it(`hides the last turn's proof while a new turn is working, and keeps the land's verdict`, () => {
        const agent = { id: `mine`, proof: { at: NOW, verification: `unproven` as const } };
        expect(cardChecks(agent, measured, false)).toEqual({ land: expect.objectContaining({ kind: `broke` }), proof: { verification: `unproven` } });
        expect(cardChecks(agent, measured, true)).toEqual({ land: expect.objectContaining({ kind: `broke` }) });
        expect(cardChecks({ id: `elsewhere`, proof: agent.proof }, undefined, true)).toBeUndefined();
    });
});
