import { type LadderInput, ladderOptionsOf, type Machine, requestedRung } from "./machineLadder";

// Pins the picker's cards as values: which rungs exist for which offers, what each badge says about cost (or why the
// rung cannot be taken), what the own-computer rung names as its next step, and which asked-for rung is honoured.

const offered: LadderInput = {
    hostedOffered: true,
    project: false,
    hostedProjects: true,
    hostedFull: false,
    hostedSuspended: false,
    plan: false,
    hours: null,
    commandOffered: true,
    installer: undefined,
};

const metaOf = (input: LadderInput): string | undefined => ladderOptionsOf(input).find((option) => option.value === `hosted`)?.meta;

describe(`the picker's rungs`, () => {
    it(`offers both rungs, hosted first, each with its trade on the card`, () => {
        expect(ladderOptionsOf(offered)).toEqual([
            { value: `hosted`, title: `Start instantly`, meta: `Free · ready in seconds`, note: `Runs on our servers` },
            { value: `mine`, title: `My own computer`, meta: `Most power · no limits`, note: `One pasted command` },
        ]);
    });

    it(`draws only the rungs the platform offers`, () => {
        expect(ladderOptionsOf({ ...offered, hostedOffered: false }).map((option) => option.value)).toEqual([`mine`]);
        expect(ladderOptionsOf({ ...offered, commandOffered: false }).map((option) => option.value)).toEqual([`hosted`]);
        expect(ladderOptionsOf({ ...offered, hostedOffered: false, commandOffered: false })).toEqual([]);
    });

    // A project's folder reaches a machine of ours only where the platform's machines can hold one (`hostedOffer.projects`);
    // a platform from before them offers a project this computer alone, and an ordinary setup its machine either way.
    it(`offers a project a machine of ours only where the platform's machines can hold one`, () => {
        const rungs = (over: Partial<LadderInput>): Machine[] => ladderOptionsOf({ ...offered, ...over }).map((option) => option.value);
        expect({
            project: rungs({ project: true }),
            olderPlatform: rungs({ project: true, hostedProjects: false }),
            ordinary: rungs({ hostedProjects: false }),
            noMachines: rungs({ project: true, hostedOffered: false }),
        }).toEqual({ project: [`hosted`, `mine`], olderPlatform: [`mine`], ordinary: [`hosted`, `mine`], noMachines: [`mine`] });
    });

    it.each<[string, Partial<LadderInput>, string]>([
        [`a full fleet, over every other fact`, { hostedFull: true, hostedSuspended: true, plan: true }, `No machines free right now`],
        [`a switched-off account`, { hostedSuspended: true, plan: true }, `Switched off for this account`],
        // A subscriber's new machine still arrives on the free rung, so the card states the free hours to them too.
        [`a subscriber, whose new machine spends the free hours`, { plan: true, hours: { allowance: 40, remaining: 40 } }, `Free · 40h a month`],
        [`a comp, whose hours count against no limit`, { plan: true }, `No hour limit · ready in seconds`],
        [`a month nothing has been spent of`, { hours: { allowance: 40, remaining: 40 } }, `Free · 40h a month`],
        [`a month partly spent, released machines included`, { hours: { allowance: 40, remaining: 12 } }, `Free · 12 of 40h left this month`],
        [
            `a new account's ramp`,
            { hours: { allowance: 8, remaining: 8, rampUntil: `2026-10-01T00:00:00.000Z` } },
            `Free to try · 8h to start, more after your first days`,
        ],
    ])(`badges the hosted rung for %s`, (_, over, meta) => {
        expect(metaOf({ ...offered, ...over })).toBe(meta);
    });

    it(`names the installer as the own computer's next step where one is offered`, () => {
        expect(ladderOptionsOf({ ...offered, installer: { label: `Windows` } })[1]?.note).toBe(`A Windows installer`);
    });

    // A phone pastes nothing into a terminal: its own-computer rung says where that setup happens instead.
    it(`tells a phone the own computer is set up from a computer, not by a pasted command`, () => {
        expect(ladderOptionsOf({ ...offered, mobile: true })[1]?.note).toBe(`Set up from a computer`);
    });

    it(`honours an asked-for rung only while it is on offer`, () => {
        expect(requestedRung(ladderOptionsOf(offered), `mine`)).toBe(`mine`);
        expect(requestedRung(ladderOptionsOf({ ...offered, hostedOffered: false }), `hosted`)).toBe(undefined);
        expect(requestedRung(ladderOptionsOf(offered), [`hosted`])).toBe(undefined);
        expect(requestedRung(ladderOptionsOf(offered), undefined)).toBe(undefined);
    });
});
