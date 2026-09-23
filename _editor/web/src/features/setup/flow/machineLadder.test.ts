import { type LadderInput, ladderOptionsOf, requestedRung } from "./machineLadder";

// Pins the picker's cards as values: which rungs exist for which offers, what each badge says about cost (or why the
// rung cannot be taken), what the own-computer rung names as its next step, and which asked-for rung is honoured.

const offered: LadderInput = {
    hostedOffered: true,
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

    it.each<[string, Partial<LadderInput>, string]>([
        [`a full fleet, over every other fact`, { hostedFull: true, hostedSuspended: true, plan: true }, `No machines free right now`],
        [`a switched-off account`, { hostedSuspended: true, plan: true }, `Switched off for this account`],
        [`the plan, which has no hours`, { plan: true, hours: { allowance: 40, remaining: 40 } }, `On your plan · always on`],
        [`a monthly ceiling and what follows it`, { hours: { allowance: 40, remaining: 12 } }, `Free to try · 40h a month, always on with the plan`],
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

    it(`honours an asked-for rung only while it is on offer`, () => {
        expect(requestedRung(ladderOptionsOf(offered), `mine`)).toBe(`mine`);
        expect(requestedRung(ladderOptionsOf({ ...offered, hostedOffered: false }), `hosted`)).toBe(undefined);
        expect(requestedRung(ladderOptionsOf(offered), [`hosted`])).toBe(undefined);
        expect(requestedRung(ladderOptionsOf(offered), undefined)).toBe(undefined);
    });
});
